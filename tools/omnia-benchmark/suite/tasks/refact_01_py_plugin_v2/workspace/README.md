# docpipe

A lightweight, stdlib-only Python document-processing pipeline SDK.

## Structure
- `docpipe/base.py`: Plugin base class (`PluginBase`)
- `docpipe/pipeline.py`: Sequential `Pipeline` runner and `default_plugins()`
- `docpipe/plugins/`: Built-in plugins (`NormalizePlugin`, `RedactPlugin`, `ChunkPlugin`, `EnrichPlugin`)
- `docpipe/cli.py`: Command-line interface (`python -m docpipe.cli --input <file.json> [--output <file.json>]`)
- `tests/test_legacy_v1.py`: Legacy v1 test suite

## Running Tests
```bash
python -m unittest discover -s tests -v
```
