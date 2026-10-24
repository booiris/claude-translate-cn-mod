import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('model_catalog', Path(__file__).parents[1] / 'hooks/model_catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class SavedStream(io.StringIO):
    def close(self):
        self.saved = self.getvalue()
        super().close()


class Child:
    def __init__(self, responses):
        self.stdin = SavedStream()
        self.stdout = io.StringIO('\n'.join(json.dumps(row) for row in responses) + '\n')
        self.terminated = False

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0


class CatalogTests(unittest.TestCase):
    def test_handshake_pagination_and_only_safe_configuration_fields(self):
        child = Child([
            {'id': 1, 'result': {}},
            {'id': 2, 'result': {'config': {'model': 'model-a', 'secret': 'never-return'}}},
            {'id': 3, 'result': {'data': [{'id': 'model-a', 'model': 'model-a'}], 'nextCursor': 'page-two'}},
            {'id': 4, 'result': {'data': [{'id': 'model-b', 'isDefault': True}], 'nextCursor': None}},
        ])
        with patch.object(catalog.subprocess, 'Popen', return_value=child) as start:
            result = catalog.query('/path with spaces/codex')
        start.assert_called_once()
        self.assertEqual(start.call_args.args[0], ['/path with spaces/codex', 'app-server', '--stdio'])
        self.assertEqual(result, {'configModel': 'model-a', 'models': [
            {'id': 'model-a', 'isDefault': False}, {'id': 'model-b', 'isDefault': True},
        ]})
        messages = [json.loads(line) for line in child.stdin.saved.splitlines()]
        self.assertEqual([message['method'] for message in messages],
                         ['initialize', 'initialized', 'config/read', 'model/list', 'model/list'])
        self.assertEqual(messages[-1]['params']['cursor'], 'page-two')
        self.assertTrue(child.terminated)

    def test_rpc_error_is_not_a_fake_model_list_and_process_is_stopped(self):
        child = Child([{'id': 1, 'error': {'message': 'rejected'}}])
        with patch.object(catalog.subprocess, 'Popen', return_value=child):
            with self.assertRaisesRegex(RuntimeError, 'initialize'):
                catalog.query('codex')
        self.assertTrue(child.terminated)


if __name__ == '__main__':
    unittest.main()
