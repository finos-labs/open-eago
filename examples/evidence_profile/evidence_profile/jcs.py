# Copyright 2026 Sankalp Gilda
# SPDX-License-Identifier: Apache-2.0
"""RFC 8785 JSON Canonicalization Scheme (JCS) for the values json.loads yields."""

from __future__ import annotations

import json
import math
from decimal import Decimal
from typing import Any


class CanonicalizationError(ValueError):
    """The value has no JCS form (non-finite number, unsupported type)."""


def _number(value: float) -> str:
    """Serialize a double the way ECMAScript Number.prototype.toString does."""
    if not math.isfinite(value):
        raise CanonicalizationError("non-finite numbers have no JCS form")
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    # repr() gives the shortest round-tripping digits, as ECMAScript does; only
    # the layout of those digits differs, so re-lay them out per ES 7.1.12.1.
    parts = Decimal(repr(abs(value))).normalize().as_tuple()
    significand = "".join(str(d) for d in parts.digits)
    k = len(significand)
    n = k + int(parts.exponent)
    sign = "-" if value < 0 else ""
    if k <= n <= 21:
        return sign + significand + "0" * (n - k)
    if 0 < n <= 21:
        return sign + significand[:n] + "." + significand[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + significand
    e = n - 1
    tail = "." + significand[1:] if k > 1 else ""
    return f"{sign}{significand[0]}{tail}e{'+' if e > 0 else '-'}{abs(e)}"


def _encode(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_encode(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(f"{_encode(k)}:{_encode(value[k])}" for k in keys) + "}"
    raise CanonicalizationError(f"type {type(value).__name__} has no JCS form")


def canonicalize(value: Any) -> bytes:
    """Return the RFC 8785 canonical UTF-8 bytes of a JSON value."""
    return _encode(value).encode("utf-8")
