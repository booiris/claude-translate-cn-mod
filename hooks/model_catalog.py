"""Read-only Codex app-server model/config queries. No thread or turn is started."""
import json
import os
import queue
import subprocess
import sys
import threading
import time


def query(binary):
    child = subprocess.Popen([binary, 'app-server', '--stdio'], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             text=True, encoding='utf-8')
    inbox = queue.Queue()

    def read():
        try:
            for line in child.stdout:
                inbox.put(json.loads(line))
        except Exception:
            pass
        finally:
            inbox.put(None)

    threading.Thread(target=read, daemon=True).start()
    deadline = time.monotonic() + 15
    counter = 0

    def send(message):
        child.stdin.write(json.dumps(message) + '\n')
        child.stdin.flush()

    def request(method, params):
        nonlocal counter
        counter += 1
        send({'id': counter, 'method': method, 'params': params})
        while True:
            message = inbox.get(timeout=max(0.001, deadline - time.monotonic()))
            if message is None:
                raise RuntimeError('Codex app-server exited')
            if message.get('id') != counter:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Codex model query timed out')
                continue
            if 'error' in message:
                raise RuntimeError('Codex rejected ' + method)
            return message['result']

    try:
        request('initialize', {'clientInfo': {'name': 'codex_translate', 'version': '0.4.0'},
                               'capabilities': {'experimentalApi': False}})
        send({'method': 'initialized', 'params': {}})
        config = request('config/read', {'includeLayers': False, 'cwd': os.getcwd()})
        models = []
        cursor = None
        seen = set()
        while True:
            params = {'limit': 100, 'includeHidden': False}
            if cursor:
                params['cursor'] = cursor
            page = request('model/list', params)
            for model in page['data']:
                model_id = model.get('model') or model.get('id')
                if model_id and model_id not in seen:
                    seen.add(model_id)
                    models.append({'id': model_id, 'isDefault': bool(model.get('isDefault'))})
            next_cursor = page.get('nextCursor')
            if not next_cursor:
                break
            if next_cursor == cursor or time.monotonic() >= deadline:
                raise RuntimeError('Invalid model pagination')
            cursor = next_cursor
        # Do not print credentials or the full configuration.
        return {'configModel': config.get('config', {}).get('model'), 'models': models}
    finally:
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        child.stdin.close()
        child.stdout.close()


if __name__ == '__main__':
    try:
        print(json.dumps(query(sys.argv[1]), ensure_ascii=False))
    except Exception:
        print('Codex model query failed', file=sys.stderr)
        sys.exit(1)
