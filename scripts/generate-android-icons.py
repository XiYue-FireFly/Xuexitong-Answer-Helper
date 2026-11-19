"""Compatibility entry point for the shared WISP icon generator."""
from pathlib import Path
from runpy import run_path

if __name__ == '__main__':
    run_path(str(Path(__file__).with_name('generate-wisp-icons.py')), run_name='__main__')
