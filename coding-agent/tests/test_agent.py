import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import agent


class Message:
    def __init__(self, content=None, tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls or []

    def model_dump(self, exclude_none=True):
        data = {"role": "assistant", "content": self.content}
        if self.tool_calls:
            data["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {
                        "name": call.function.name,
                        "arguments": call.function.arguments,
                    },
                }
                for call in self.tool_calls
            ]
        return {key: value for key, value in data.items() if value is not None}


def tool_call(name="echo", arguments='{"text":"hello"}', call_id="call-1"):
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(name=name, arguments=arguments),
    )


class FakeCompletions:
    def __init__(self, messages):
        self.responses = list(messages)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = self.responses.pop(0)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def fake_client(*messages):
    completions = FakeCompletions(messages)
    return SimpleNamespace(chat=SimpleNamespace(completions=completions)), completions


class ConfigurationTests(unittest.TestCase):
    def test_loads_active_provider_and_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_dir = root / "config"
            (config_dir / "prompts").mkdir(parents=True)
            (config_dir / "settings.toml").write_text(
                'active_provider = "deepseek"\n'
                '[agent]\nprompt = "react"\nmax_steps = 3\n'
                '[providers.deepseek]\nAGENT_API_KEY = "secret"\n'
                'base_url = "https://example.test"\nmodel = "model-x"\n',
                encoding="utf-8",
            )
            (config_dir / "prompts.toml").write_text(
                '[prompts.react]\npath = "prompts/react.md"\n', encoding="utf-8"
            )
            (config_dir / "prompts" / "react.md").write_text("react prompt", encoding="utf-8")

            runtime = agent.load_runtime(root)

            self.assertEqual(runtime["provider"]["model"], "model-x")
            self.assertEqual(runtime["prompt"], "react prompt")
            self.assertEqual(runtime["max_steps"], 3)

    def test_rejects_missing_required_provider_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_dir = root / "config"
            config_dir.mkdir()
            (config_dir / "settings.toml").write_text(
                'active_provider = "openai"\n'
                '[agent]\nprompt = "react"\n'
                '[providers.openai]\nAGENT_API_KEY = ""\nbase_url = ""\nmodel = ""\n',
                encoding="utf-8",
            )
            (config_dir / "prompts.toml").write_text('[prompts.react]\npath = "missing.md"\n')

            with self.assertRaisesRegex(ValueError, "AGENT_API_KEY"):
                agent.load_runtime(root)

    def test_empty_tool_registry_loads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_dir = root / "config"
            config_dir.mkdir()
            (config_dir / "tools.json").write_text('{"tools": []}\n', encoding="utf-8")

            specs, handlers = agent.load_tools(root)

            self.assertEqual(specs, [])
            self.assertEqual(handlers, {})


class AgentLoopTests(unittest.TestCase):
    def test_returns_final_answer_without_sending_empty_tools(self):
        client, completions = fake_client(Message(content="done"))
        messages = [{"role": "system", "content": "prompt"}]

        result = agent.run_agent_turn(client, "model-x", messages, [], {}, 3)

        self.assertEqual(result, "done")
        self.assertNotIn("tools", completions.calls[0])
        self.assertEqual(messages[-1]["content"], "done")

    def test_executes_registered_tool_and_records_observation(self):
        client, _ = fake_client(
            Message(tool_calls=[tool_call()]),
            Message(content="finished"),
        )
        messages = [{"role": "user", "content": "say hello"}]
        output = []

        result = agent.run_agent_turn(
            client,
            "model-x",
            messages,
            [{"type": "function", "function": {"name": "echo"}}],
            {"echo": lambda text: text},
            3,
            output.append,
        )

        self.assertEqual(result, "finished")
        self.assertEqual([message["role"] for message in messages], ["user", "assistant", "tool", "assistant"])
        self.assertEqual(messages[2]["content"], "hello")
        self.assertTrue(any(line.startswith("Action:") for line in output))
        self.assertTrue(any(line.startswith("Observation:") for line in output))

    def test_tool_errors_become_observations(self):
        cases = [
            (tool_call(name="missing"), {}, "未注册工具"),
            (tool_call(arguments="{"), {"echo": lambda text: text}, "参数不是合法 JSON"),
            (tool_call(), {"echo": lambda text: 1 / 0}, "工具执行失败"),
        ]
        for call, handlers, expected in cases:
            with self.subTest(expected=expected):
                client, _ = fake_client(Message(tool_calls=[call]), Message(content="recovered"))
                messages = [{"role": "user", "content": "run"}]

                result = agent.run_agent_turn(
                    client, "model-x", messages, [], handlers, 3, lambda _: None
                )

                self.assertEqual(result, "recovered")
                self.assertIn(expected, messages[2]["content"])

    def test_stops_after_max_steps(self):
        client, _ = fake_client(Message(tool_calls=[tool_call()]))

        with self.assertRaisesRegex(RuntimeError, "最大步骤"):
            agent.run_agent_turn(
                client,
                "model-x",
                [{"role": "user", "content": "loop"}],
                [],
                {"echo": lambda text: text},
                1,
                lambda _: None,
            )


if __name__ == "__main__":
    unittest.main()
