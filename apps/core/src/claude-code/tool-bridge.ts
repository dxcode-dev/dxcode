/**
 * The dx tool bridge: the program between the Claude Code CLI and the run's
 * output chunks. Claude reads its input, and every answer from dx, from the
 * run's control pipe; the bridge writes both. It serves dx's tools to Claude
 * as an in-process ("SDK") MCP server over Claude Code's stream-json control
 * protocol, so Claude needs no separate MCP server
 * process:
 *
 * 1. It announces the server with `initialize` (`sdkMcpServers: ["dx"]`),
 *    then writes the run's input once Claude acknowledges.
 * 2. Claude sends each MCP message as a `control_request` of subtype
 *    `mcp_message`; the bridge answers `initialize` and `tools/list` itself
 *    and each `tools/call` with the result dx's own tool wrote: Flue runs
 *    the real tool when the call's segment reaches it, then writes
 *    `results/<tool_use id>.json`. Claude names the call's tool_use id in
 *    `_meta`, so no request needs matching by content.
 * 3. Every other line of Claude's output passes through to the chunker
 *    unchanged; control traffic does not. After Claude's `result` the bridge
 *    closes the pipe, and Claude exits.
 *
 * The runner starts Claude with `CLAUDE_AGENT_SDK_MCP_NO_PREFIX=1`, which
 * drops the `mcp__dx__` prefix for an SDK server's tools: Claude sees dx's
 * tools under the names dx's own loop uses. Each tool is listed with
 * `anthropic/alwaysLoad`, so Claude calls it without a tool search.
 *
 * Python's standard library only: it also runs where the local runtime's
 * namespace hides the developer's home-directory Node.js. Each call waits in
 * its own thread so other messages keep flowing.
 */
export const CLAUDE_CODE_TOOL_BRIDGE = `import json, os, sys, threading, time

tools_path, mcp_dir, input_path = sys.argv[1], sys.argv[2], sys.argv[3]
results = os.path.join(mcp_dir, "results")
tools = json.load(open(tools_path))
for tool in tools:
    tool.setdefault("_meta", {})["anthropic/alwaysLoad"] = True
to_claude = os.fdopen(4, "w")
lock = threading.Lock()
cancelled = set()
state = {"input": False, "closed": False}
WAIT_SECONDS = 30 * 60
INSTRUCTIONS = "Tools from dx, the harness running this session. They run in dx, and their results are shown in the dx thread."


def send(message):
    with lock:
        if state["closed"]:
            return
        try:
            to_claude.write(json.dumps(message) + "\\n")
            to_claude.flush()
        except (BrokenPipeError, ValueError):
            state["closed"] = True


def close():
    with lock:
        if not state["closed"]:
            state["closed"] = True
            try:
                to_claude.close()
            except OSError:
                pass


def write_input():
    if state["input"]:
        return
    state["input"] = True
    with open(input_path) as handle:
        for line in handle:
            if line.strip():
                send(json.loads(line))


def reply(request_id, response):
    send({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response}})


def refuse(request_id, error):
    send({"type": "control_response", "response": {"subtype": "error", "request_id": request_id, "error": error}})


def mcp(request_id, message):
    reply(request_id, {"mcp_response": message})


def text_result(text, error=False):
    return {"content": [{"type": "text", "text": text}], "isError": error}


def wait_for(rpc_id, tool_use):
    path = os.path.join(results, tool_use + ".json")
    deadline = time.time() + WAIT_SECONDS
    while True:
        if rpc_id in cancelled:
            return None
        if os.path.exists(path):
            try:
                with open(path) as handle:
                    return json.load(handle)
            except ValueError:
                pass  # dx is still writing it
        if time.time() > deadline:
            return text_result("dx did not finish this tool call in time.", True)
        time.sleep(0.2)


def call(request_id, rpc_id, params):
    try:
        tool_use = str((params.get("_meta") or {}).get("claudecode/toolUseId", ""))
        if not tool_use.replace("_", "").replace("-", "").isalnum():
            result = text_result("dx received this call without its tool_use id.", True)
        else:
            result = wait_for(rpc_id, tool_use)
        if result is not None:
            mcp(request_id, {"jsonrpc": "2.0", "id": rpc_id, "result": result})
    except Exception as error:  # every call gets an answer
        mcp(request_id, {"jsonrpc": "2.0", "id": rpc_id, "result": text_result("dx could not return this tool call: %s" % error, True)})


def mcp_message(request_id, message):
    method, rpc_id = message.get("method"), message.get("id")
    params = message.get("params") or {}
    if method == "initialize":
        mcp(request_id, {"jsonrpc": "2.0", "id": rpc_id, "result": {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "dx", "version": "1"},
            "instructions": INSTRUCTIONS}})
    elif method == "tools/list":
        mcp(request_id, {"jsonrpc": "2.0", "id": rpc_id, "result": {"tools": tools}})
    elif method == "tools/call":
        threading.Thread(target=call, args=(request_id, rpc_id, params), daemon=True).start()
    elif method == "notifications/cancelled":
        cancelled.add(params.get("requestId"))
        mcp(request_id, {"jsonrpc": "2.0", "result": {}})
    elif rpc_id is None:
        mcp(request_id, {"jsonrpc": "2.0", "result": {}})
    else:
        mcp(request_id, {"jsonrpc": "2.0", "id": rpc_id, "result": {}})


send({"type": "control_request", "request_id": "dx-initialize", "request": {"subtype": "initialize", "sdkMcpServers": ["dx"]}})
for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        message = None
    kind = message.get("type") if isinstance(message, dict) else None
    if kind == "control_request":
        request = message.get("request") or {}
        if request.get("subtype") == "mcp_message" and request.get("server_name") == "dx":
            mcp_message(message.get("request_id"), request.get("message") or {})
        else:
            refuse(message.get("request_id"), "dx does not handle %s." % request.get("subtype"))
        continue
    if kind == "control_response":
        if (message.get("response") or {}).get("request_id") == "dx-initialize":
            write_input()
        continue
    if kind == "control_cancel_request":
        continue
    sys.stdout.write(line)
    sys.stdout.flush()
    if kind == "result":
        close()
close()
`;
