"""Run translations through Codex with zero tools or one bounded transcript reader.

Accept the existing exec arguments and emit the same small JSONL result protocol.
All configuration and catalog overrides are temporary; user settings are untouched.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import tomllib

DISABLED_FEATURES = (
    'shell_tool', 'multi_agent', 'multi_agent_v2', 'goals', 'apps', 'plugins',
    'image_generation', 'current_time_reminder', 'view_image', 'sleep_tool', 'code_mode', 'browser_use', 'computer_use',
    'request_permissions_tool', 'default_mode_request_user_input',
    'send_message_to_user_async', 'hooks', 'memories', 'skill_search',
)
READ_TOOL = {
    'type': 'function', 'name': 'read_claude_transcript',
    'description': 'Read recent text from the current Claude session transcript. Read-only; no other files are accessible. Offset is bytes back from the end.',
    'inputSchema': {'type': 'object', 'properties': {
        'offset': {'type': 'integer', 'minimum': 0},
        'max_bytes': {'type': 'integer', 'minimum': 1, 'maximum': 24000},
    }, 'additionalProperties': False},
}


def read_transcript(path, arguments):
    if not path or not isinstance(arguments, dict) or set(arguments) - {'offset', 'max_bytes'}:
        raise ValueError('Transcript unavailable or invalid arguments')
    offset, limit = arguments.get('offset', 0), arguments.get('max_bytes', 12000)
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 24000:
        raise ValueError('Invalid read range')
    with open(path, 'rb') as source:
        source.seek(0, os.SEEK_END)
        size = source.tell()
        end = max(0, size - offset)
        start = max(0, end - limit)
        source.seek(start)
        text = source.read(end - start).decode('utf-8', errors='replace')
    return {'text': text, 'start_byte': start, 'end_byte': end, 'file_bytes': size,
            'next_offset': size - start if start else None}


def minimal_catalog(catalog):
    # Model metadata otherwise enables apply_patch, clock and code-mode wrappers
    # even when the corresponding CLI feature switches are disabled.
    for model in catalog['models']:
        model.update(tool_mode='direct', apply_patch_tool_type=None,
                     experimental_supported_tools=[], supports_search_tool=False,
                     include_skills_usage_instructions=False,
                     include_plugin_usage_instructions=False,
                     include_apps_usage_instructions=False)
    return catalog


def parse_exec(argv):
    binary, command, *args = argv
    if command != 'exec':
        raise ValueError('Expected codex exec')
    config, model, resume = {}, None, None
    ephemeral = '--ephemeral' in args
    i = 0
    while i < len(args):
        if args[i] == '-c':
            key, value = args[i + 1].split('=', 1)
            config[key] = tomllib.loads('value=' + value)['value']
            i += 2
        elif args[i] == '--model':
            model = args[i + 1]
            i += 2
        elif args[i] == 'resume':
            resume = args[i + 1]
            i += 2
        else:
            i += 1
    return binary, config, model, resume, ephemeral


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


class Server:
    def __init__(self, argv, deadline, transcript):
        self.child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                                      start_new_session=True)
        self.deadline, self.transcript = deadline, transcript
        self.inbox, self.counter, self.events = queue.Queue(), 0, []
        def read():
            try:
                for line in self.child.stdout:
                    self.inbox.put(json.loads(line))
            except Exception:
                pass
            finally:
                self.inbox.put(None)
        threading.Thread(target=read, daemon=True).start()

    def send(self, message):
        self.child.stdin.write(json.dumps(message) + '\n')
        self.child.stdin.flush()

    def receive(self):
        while True:
            message = self.inbox.get(timeout=max(0.001, self.deadline - time.monotonic()))
            if message is None:
                raise RuntimeError('Codex app-server exited')
            if 'method' in message and 'id' in message:
                # No approvals, arbitrary file access or other client tools.
                params = message.get('params', {})
                if message['method'] == 'item/tool/call':
                    try:
                        if params.get('tool') != READ_TOOL['name']:
                            raise ValueError('Tool unavailable')
                        result = read_transcript(self.transcript, params.get('arguments'))
                        response = {'success': True, 'contentItems': [{'type': 'inputText', 'text': json.dumps(result, ensure_ascii=False)}]}
                    except (OSError, ValueError):
                        response = {'success': False, 'contentItems': [{'type': 'inputText', 'text': 'Transcript unavailable or invalid read range.'}]}
                    self.send({'id': message['id'], 'result': response})
                else:
                    self.send({'id': message['id'], 'error': {'code': -32601, 'message': 'Unsupported translation request'}})
                continue
            return message

    def request(self, method, params):
        self.counter += 1
        request_id = self.counter
        self.send({'id': request_id, 'method': method, 'params': params})
        while True:
            message = self.receive()
            if message.get('id') == request_id:
                if 'error' in message:
                    raise RuntimeError('Codex rejected ' + method + ': ' + message['error'].get('message', 'unknown error'))
                return message['result']
            self.events.append(message)

    def close(self):
        try:
            os.killpg(self.child.pid, signal.SIGTERM)
            self.child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(self.child.pid, signal.SIGKILL)
            self.child.wait()
        except ProcessLookupError:
            pass
        self.child.stdin.close()
        self.child.stdout.close()


def run(argv, transcript, source):
    binary, config, model, resume, ephemeral = parse_exec(argv)
    deadline = time.monotonic() + 600
    # Ask the selected binary for its catalog, preserving provider/model metadata.
    result = subprocess.run([binary, 'debug', 'models'], capture_output=True, text=True,
                            encoding='utf-8', timeout=20, check=True)
    catalog = minimal_catalog(json.loads(result.stdout))
    with tempfile.TemporaryDirectory(prefix='codex-translate-') as temporary:
        catalog_path = Path(temporary) / 'models.json'
        catalog_path.write_text(json.dumps(catalog), encoding='utf-8')
        overrides = {**config, **{'features.' + name: False for name in DISABLED_FEATURES},
                     'agents.enabled': False, 'skills.include_instructions': False,
                     'features.skip_host_skill_discovery': True, 'web_search': 'disabled',
                     'tools.update_plan.enabled': False, 'tools.experimental_request_user_input.enabled': False,
                     'model_catalog_json': str(catalog_path), 'project_doc_max_bytes': 0}
        args = [binary, 'app-server', '--stdio']
        for key, value in overrides.items():
            args += ['-c', key + '=' + json.dumps(value)]
        server = Server(args, deadline, transcript)
        try:
            server.request('initialize', {'clientInfo': {'name': 'codex_translate', 'version': '0.5.0'},
                                          'capabilities': {'experimentalApi': True}})
            server.send({'method': 'initialized', 'params': {}})
            effective = server.request('config/read', {'includeLayers': False, 'cwd': os.getcwd()})['config']
            selected = model or effective.get('model')
            if selected and selected not in {entry['slug'] for entry in catalog['models']}:
                raise RuntimeError('Selected model is absent from the Codex model catalog; tool isolation cannot be guaranteed')
            # Disable every inherited MCP server, regardless of user-defined names.
            overrides['mcp_servers'] = {name: {'enabled': False, **{key: value for key, value in settings.items() if key in ('command', 'url') and value is not None}}
                                        for name, settings in effective.get('mcp_servers', {}).items()}
            params = {'cwd': os.getcwd(), 'approvalPolicy': 'never', 'sandbox': 'read-only',
                      'config': overrides, 'baseInstructions': Path(config['model_instructions_file']).read_text(),
                      'developerInstructions': config.get('developer_instructions', '')}
            if model:
                params['model'] = model
            if resume:
                params.update(threadId=resume)
                started = server.request('thread/resume', params)
            else:
                params.update(ephemeral=ephemeral, dynamicTools=[READ_TOOL] if transcript and not ephemeral else [])
                started = server.request('thread/start', params)
            thread = started['thread']['id']
            emit({'type': 'thread.started', 'thread_id': thread})
            server.events.clear()
            turn = server.request('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': source}]})
            turn_id = turn['turn']['id']
            usage = None
            answer = ''
            while True:
                event = server.events.pop(0) if server.events else server.receive()
                payload = event.get('params', {})
                if payload.get('threadId') != thread:
                    continue
                method = event.get('method')
                if method == 'thread/tokenUsage/updated' and payload.get('turnId') == turn_id:
                    total = payload['tokenUsage']['total']
                    usage = {key: total.get(field) for key, field in (
                        ('input_tokens', 'inputTokens'), ('output_tokens', 'outputTokens'),
                        ('cached_input_tokens', 'cachedInputTokens'))}
                elif method == 'item/completed' and payload.get('turnId') == turn_id:
                    item = payload.get('item', {})
                    if item.get('type') == 'agentMessage':
                        answer = item.get('text', '')
                elif method == 'turn/completed' and payload.get('turn', {}).get('id') == turn_id:
                    if payload['turn'].get('status') != 'completed' or not answer.strip():
                        raise RuntimeError('Translation failed')
                    emit({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': answer}})
                    emit({'type': 'turn.completed', 'usage': usage or {}})
                    return
        finally:
            server.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--transcript', default='')
    parser.add_argument('exec_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.exec_args[1:] if args.exec_args[:1] == ['--'] else args.exec_args
    # Host cancellation closes the helper; always reap its app-server child.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    try:
        run(argv, args.transcript, sys.stdin.read())
    except Exception as error:
        print('Translation runner failed: ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
