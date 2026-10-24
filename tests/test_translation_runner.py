import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('runner', Path(__file__).parents[1] / 'hooks/translation_runner.py')
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class TranscriptTests(unittest.TestCase):
    def test_pagination_is_bounded_and_reads_only_selected_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'transcript'
            path.write_bytes(b'first-second-third')
            result = runner.read_transcript(path, {'max_bytes': 5})
            self.assertEqual(result['text'], 'third')
            self.assertEqual(result['next_offset'], 5)
            result = runner.read_transcript(path, {'offset': 5, 'max_bytes': 7})
            self.assertEqual(result['text'], 'second-')
            self.assertEqual(runner.read_transcript(path, {'offset': 999})['text'], '')
            with self.assertRaises(ValueError):
                runner.read_transcript(path, {'path': '/etc/passwd'})

    def test_invalid_ranges_and_missing_path_fail(self):
        for args in ({'offset': -1}, {'offset': True}, {'max_bytes': 24001},
                     {'max_bytes': 0}, {'max_bytes': '100'}, []):
            with self.assertRaises(ValueError):
                runner.read_transcript('/unavailable', args)
        with self.assertRaises(ValueError):
            runner.read_transcript('', {})

    def test_catalog_preserves_model_identity_and_clears_tool_metadata(self):
        model = {'slug': 'custom-model', 'context_window': 1234, 'tool_mode': 'code_mode_only',
                 'experimental_supported_tools': ['clock'], 'apply_patch_tool_type': 'freeform'}
        catalog = runner.minimal_catalog({'models': [model]})
        self.assertEqual(catalog['models'][0]['slug'], 'custom-model')
        self.assertEqual(model['context_window'], 1234)
        self.assertEqual(model['experimental_supported_tools'], [])
        self.assertIsNone(model['apply_patch_tool_type'])
        self.assertEqual(model['tool_mode'], 'direct')

    def test_parse_preserves_model_and_resume_id_without_shell_evaluation(self):
        binary, config, model, resume, ephemeral = runner.parse_exec([
            '/a path/codex', 'exec', '-c', 'developer_instructions="quoted text"',
            '--model', 'test-model', 'resume', 'thread-id', '-'])
        self.assertEqual(binary, '/a path/codex')
        self.assertEqual(config['developer_instructions'], 'quoted text')
        self.assertEqual((model, resume, ephemeral), ('test-model', 'thread-id', False))


if __name__ == '__main__':
    unittest.main()
