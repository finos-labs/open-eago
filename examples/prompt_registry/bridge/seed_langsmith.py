"""
seed_langsmith.py — Push all prompts from prompts/ to LangSmith and print the commit hashes.

Useful for initial setup or to verify LangSmith connectivity before running registry_bridge.py.

Usage:
    python seed_langsmith.py                      # push all prompts
    python seed_langsmith.py --prompt-name bank-aml-agent  # push one

Environment variables (or .env file):
    LANGCHAIN_API_KEY   LangSmith API key
"""

import argparse
from pathlib import Path

from dotenv import load_dotenv

from langsmith_client import PROMPTS_DIR, load_local_prompt, push_to_langsmith

load_dotenv()


def seed_one(prompt_name: str) -> None:
    spec, canonical, content_hash = load_local_prompt(prompt_name)
    print(f"Pushing '{prompt_name}'...")
    commit = push_to_langsmith(spec)
    print(f"  ✓ commit : {commit}")
    print(f"  ✓ hash   : 0x{content_hash.hex()}")
    print(f"  Set: {prompt_name.upper().replace('-', '_')}_PROMPT_VERSION={commit}")


def main():
    parser = argparse.ArgumentParser(description="Seed LangSmith with prompts from prompts/")
    parser.add_argument("--prompt-name", default=None, help="Push a single prompt (default: all)")
    args = parser.parse_args()

    if args.prompt_name:
        seed_one(args.prompt_name)
    else:
        names = sorted(p.stem for p in PROMPTS_DIR.glob("*.yaml"))
        if not names:
            print(f"No .yaml files found in {PROMPTS_DIR}")
            return
        for name in names:
            seed_one(name)
            print()


if __name__ == "__main__":
    main()
