/**
 * The `dx` MCP server Claude Code starts in the workspace. It lists the dx
 * tools of the attempt and answers each call with the result dx's own tool
 * wrote for it: Flue runs the real tool when the call's segment reaches it,
 * then writes `results/<tool_use id>.json`. Claude Code names the call's
 * tool_use id in `_meta`, so no request needs matching by content.
 *
 * Python's standard library only: the server must start inside the local
 * runtime's mount namespace, where the developer's home-directory Node.js is
 * hidden. Each call waits in its own thread so pings and cancellations keep
 * flowing.
 */
export const CLAUDE_CODE_MCP_SERVER = `import json, os, sys, threading, time

tools_path, results = sys.argv[1], os.path.join(sys.argv[2], "results")
tools = json.load(open(tools_path))
lock = threading.Lock()
cancelled = set()
WAIT_SECONDS = 30 * 60


def send(message):
    with lock:
        sys.stdout.write(json.dumps(message) + "\\n")
        sys.stdout.flush()


def answer(request_id, text, error=False):
    send({"jsonrpc": "2.0", "id": request_id, "result": {
        "content": [{"type": "text", "text": text}], "isError": error}})


def wait_for(request_id, tool_use):
    path = os.path.join(results, tool_use + ".json")
    deadline = time.time() + WAIT_SECONDS
    while True:
        if request_id in cancelled:
            return None
        if os.path.exists(path):
            try:
                with open(path) as handle:
                    return json.load(handle)
            except ValueError:
                pass  # dx is still writing it
        if time.time() > deadline:
            return {"content": [{"type": "text", "text": "dx did not finish this tool call in time."}], "isError": True}
        time.sleep(0.2)


def call(request_id, params):
    try:
        tool_use = str((params.get("_meta") or {}).get("claudecode/toolUseId", ""))
        if not tool_use.replace("_", "").replace("-", "").isalnum():
            answer(request_id, "dx received this call without its tool_use id.", True)
            return
        result = wait_for(request_id, tool_use)
        if result is not None:
            send({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Exception as error:  # every call gets an answer
        answer(request_id, "dx could not return this tool call: %s" % error, True)


for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        continue
    method, request_id = message.get("method"), message.get("id")
    params = message.get("params") or {}
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "dx", "version": "1"},
            "instructions": "Tools from dx, the harness running this session. They run in dx, and their results are shown in the dx thread."}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": tools}})
    elif method == "tools/call":
        threading.Thread(target=call, args=(request_id, params), daemon=True).start()
    elif method == "notifications/cancelled":
        cancelled.add(params.get("requestId"))
    elif request_id is not None:
        send({"jsonrpc": "2.0", "id": request_id, "result": {}})
`;
