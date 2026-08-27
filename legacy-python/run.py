from pathlib import Path
import os
import runpy


HERE = Path(__file__).resolve().parent
os.chdir(HERE)
runpy.run_path("main.py", run_name="__main__")
