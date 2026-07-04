import importlib
import json
import tomllib
from pathlib import Path

from openai import OpenAI, OpenAIError


BASE_DIR = Path(__file__).resolve().parent


def _read_toml(path):
    try:
        with path.open("rb") as file:
            return tomllib.load(file)
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ValueError(f"无法读取配置文件 {path.name}: {error}") from error


def load_runtime(root=BASE_DIR):
    root = Path(root)
    config = _read_toml(root / "config.toml")
    provider_name = config.get("active_provider", "")
    provider = config.get("providers", {}).get(provider_name)
    if not provider:
        raise ValueError(f"未找到供应商配置: {provider_name}")

    for key in ("AGENT_API_KEY", "base_url", "model"):
        if not provider.get(key):
            raise ValueError(f"供应商 {provider_name} 缺少配置: {key}")

    agent_config = config.get("agent", {})
    prompt_name = agent_config.get("prompt", "")
    prompt_config = _read_toml(root / "prompts.toml").get("prompts", {}).get(prompt_name)
    if not prompt_config or not prompt_config.get("path"):
        raise ValueError(f"未找到 Prompt 配置: {prompt_name}")

    prompt_path = (root / prompt_config["path"]).resolve()
    if not prompt_path.is_relative_to(root.resolve()):
        raise ValueError("Prompt 路径不能超出项目目录")
    try:
        prompt = prompt_path.read_text(encoding="utf-8")
    except OSError as error:
        raise ValueError(f"无法读取 Prompt: {prompt_path}") from error

    max_steps = agent_config.get("max_steps", 10)
    if not isinstance(max_steps, int) or max_steps < 1:
        raise ValueError("max_steps 必须是正整数")
    return {"provider": provider, "prompt": prompt, "max_steps": max_steps}


def load_tools(root=BASE_DIR):
    entries = _read_toml(Path(root) / "tools.toml").get("tools", [])
    specs = []
    handlers = {}
    for entry in entries:
        if not entry.get("enabled", True):
            continue
        name = entry.get("name", "")
        if not name or name in handlers:
            raise ValueError(f"工具名称为空或重复: {name}")
        try:
            handler = getattr(importlib.import_module(entry["module"]), entry["function"])
        except (KeyError, ImportError, AttributeError) as error:
            raise ValueError(f"无法加载工具 {name}: {error}") from error
        if not callable(handler):
            raise ValueError(f"工具不可调用: {name}")

        handlers[name] = handler
        specs.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": entry.get("description", ""),
                    "parameters": entry.get(
                        "parameters",
                        {"type": "object", "properties": {}, "additionalProperties": False},
                    ),
                },
            }
        )
    return specs, handlers


def _assistant_message(message):
    result = {"role": "assistant"}
    if message.content is not None:
        result["content"] = message.content
    if message.tool_calls:
        dumped = message.model_dump(exclude_none=True)
        result["tool_calls"] = dumped["tool_calls"]
    return result


def _tool_result(handler, arguments):
    result = handler(**arguments)
    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False)


def run_agent_turn(client, model, messages, tool_specs, handlers, max_steps, output=print):
    for _ in range(max_steps):
        request = {"model": model, "messages": messages}
        if tool_specs:
            request.update(tools=tool_specs, tool_choice="auto")
        response = client.chat.completions.create(**request)
        message = response.choices[0].message
        messages.append(_assistant_message(message))

        if not message.tool_calls:
            return message.content or ""

        for call in message.tool_calls:
            name = call.function.name
            raw_arguments = call.function.arguments
            output(f"Action: {name}({raw_arguments})")
            if name not in handlers:
                observation = f"未注册工具: {name}"
            else:
                try:
                    arguments = json.loads(raw_arguments)
                    if not isinstance(arguments, dict):
                        raise ValueError("参数必须是 JSON 对象")
                    observation = _tool_result(handlers[name], arguments)
                except json.JSONDecodeError:
                    observation = f"参数不是合法 JSON: {raw_arguments}"
                except Exception as error:
                    observation = f"工具执行失败: {error}"
            output(f"Observation: {observation}")
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": observation,
                }
            )
    raise RuntimeError(f"已达到最大步骤数 {max_steps}")


def main():
    try:
        runtime = load_runtime()
        tool_specs, handlers = load_tools()
    except ValueError as error:
        raise SystemExit(f"配置错误: {error}") from error

    provider = runtime["provider"]
    client = OpenAI(api_key=provider["AGENT_API_KEY"], base_url=provider["base_url"])
    messages = [{"role": "system", "content": runtime["prompt"]}]
    print("ReAct Agent 已启动，输入 exit 或 quit 退出。")

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if user_input.lower() in {"exit", "quit"}:
            break
        if not user_input:
            continue

        messages.append({"role": "user", "content": user_input})
        try:
            answer = run_agent_turn(
                client,
                provider["model"],
                messages,
                tool_specs,
                handlers,
                runtime["max_steps"],
            )
            print(f"Agent: {answer}")
        except (OpenAIError, RuntimeError) as error:
            print(f"Agent 错误: {error}")


if __name__ == "__main__":
    main()
