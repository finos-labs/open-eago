#!/usr/bin/env python3
"""OpenEAGO conformance test runner.

Validates each fixture in tests/conformance/ against its declared schema.
Each fixture is a JSON object with:
  - requirement_id: the OASF requirement being tested
  - schema: path to the JSON Schema file (relative to repo root)
  - cases: list of {id, description, valid, payload}

Exit code 0 = all cases passed. Exit code 1 = one or more failures.

Usage:
    python tests/run_conformance.py [--verbose]

Requirements:
    pip install jsonschema
"""
import argparse
import json
import sys
from pathlib import Path

try:
    import jsonschema
    from jsonschema import Draft202012Validator
except ImportError:
    print("ERROR: jsonschema not installed.\n  pip install jsonschema")
    sys.exit(1)

REPO_ROOT = Path(__file__).parent.parent
CONFORMANCE_DIR = Path(__file__).parent / "conformance"


def load_json(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def run_suite(suite_file: Path, verbose: bool) -> tuple[int, int]:
    suite = load_json(suite_file)
    req_id = suite.get("requirement_id", suite_file.stem)
    description = suite.get("description", "")
    schema_path = REPO_ROOT / suite["schema"]
    schema = load_json(schema_path)

    validator_cls = Draft202012Validator
    validator_cls.check_schema(schema)

    passed = failed = 0
    case_lines = []

    for case in suite["cases"]:
        case_id = case["id"]
        expected_valid = case["valid"]
        payload = case["payload"]

        validator = validator_cls(schema)
        errors = list(validator.iter_errors(payload))
        actually_valid = len(errors) == 0

        if actually_valid == expected_valid:
            passed += 1
            if verbose:
                case_lines.append(f"    PASS  {case_id}")
        else:
            failed += 1
            direction = "valid" if expected_valid else "invalid"
            got = "valid" if actually_valid else "invalid"
            case_lines.append(f"    FAIL  {case_id}")
            case_lines.append(f"          expected: {direction}  got: {got}")
            case_lines.append(f"          {case.get('description', '')}")
            if actually_valid is False and expected_valid is True:
                for err in errors[:2]:
                    case_lines.append(f"          schema error: {err.message} (at {list(err.path)})")

    suite_status = "PASS" if failed == 0 else "FAIL"
    print(f"  [{suite_status}] {req_id}: {description}")
    print(f"         {passed}/{passed + failed} cases passed")
    for line in case_lines:
        print(line)

    return passed, failed


def main():
    parser = argparse.ArgumentParser(description="OpenEAGO conformance runner")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show passing cases too")
    args = parser.parse_args()

    suite_files = sorted(CONFORMANCE_DIR.glob("*.json"))
    if not suite_files:
        print(f"No conformance fixtures found in {CONFORMANCE_DIR}")
        sys.exit(1)

    print(f"\nOpenEAGO Conformance Suite  (spec v0.1.0)")
    print("=" * 50)

    total_passed = total_failed = 0
    for suite_file in suite_files:
        p, f = run_suite(suite_file, args.verbose)
        total_passed += p
        total_failed += f

    print("=" * 50)
    print(f"Result: {total_passed} passed, {total_failed} failed\n")

    if total_failed > 0:
        print("CONFORMANCE FAILED")
        sys.exit(1)
    else:
        print("CONFORMANCE PASSED")
        sys.exit(0)


if __name__ == "__main__":
    main()
