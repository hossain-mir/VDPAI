"""Small JSON-Schema subset validator for tool arguments.

Deliberately dependency free: the Android Termux image has no ``jsonschema``
wheel, and tool arguments need strict, predictable checks rather than full
schema support.
"""

from __future__ import annotations

import re

from backend.core.errors import ValidationError


def _fail(message: str) -> None:
    raise ValidationError(message)


def validate_arguments(schema: dict, arguments: object) -> dict:
    if not isinstance(arguments, dict):
        _fail("Tool arguments must be a JSON object.")

    properties: dict = schema.get("properties", {}) or {}
    required: list = schema.get("required", []) or []
    extra_allowed = bool(schema.get("additionalProperties", False))

    if not extra_allowed:
        unknown = sorted(set(arguments) - set(properties))
        if unknown:
            _fail(f"Unknown argument(s): {', '.join(unknown)}")

    for key in required:
        if key not in arguments:
            _fail(f"Missing required argument: {key}")

    cleaned: dict = {}
    for key, value in arguments.items():
        spec = properties.get(key)
        if not spec:
            if extra_allowed:
                cleaned[key] = value
            continue
        cleaned[key] = _validate_value(key, spec, value)
    return cleaned


def _validate_value(name: str, spec: dict, value):
    kind = spec.get("type")

    if kind == "string":
        if not isinstance(value, str):
            _fail(f"'{name}' must be a string.")
        if "maxLength" in spec and len(value) > int(spec["maxLength"]):
            _fail(f"'{name}' exceeds {spec['maxLength']} characters.")
        if "minLength" in spec and len(value) < int(spec["minLength"]):
            _fail(f"'{name}' is too short.")
        if "enum" in spec and value not in spec["enum"]:
            _fail(f"'{name}' must be one of: {', '.join(map(str, spec['enum']))}.")
        if "pattern" in spec and not re.match(str(spec["pattern"]), value):
            _fail(f"'{name}' has an invalid format.")
        return value

    if kind in {"integer", "number"}:
        if isinstance(value, bool):
            _fail(f"'{name}' must be a number.")
        if isinstance(value, str):
            try:
                value = float(value) if kind == "number" else int(value)
            except ValueError:
                _fail(f"'{name}' must be a number.")
        if not isinstance(value, (int, float)):
            _fail(f"'{name}' must be a number.")
        if kind == "integer":
            if isinstance(value, float) and not value.is_integer():
                _fail(f"'{name}' must be an integer.")
            value = int(value)
        if "minimum" in spec and value < spec["minimum"]:
            _fail(f"'{name}' must be >= {spec['minimum']}.")
        if "maximum" in spec and value > spec["maximum"]:
            _fail(f"'{name}' must be <= {spec['maximum']}.")
        return value

    if kind == "boolean":
        if not isinstance(value, bool):
            _fail(f"'{name}' must be true or false.")
        return value

    if kind == "array":
        if not isinstance(value, list):
            _fail(f"'{name}' must be an array.")
        max_items = int(spec.get("maxItems", 50))
        if len(value) > max_items:
            _fail(f"'{name}' may contain at most {max_items} items.")
        item_spec = spec.get("items") or {}
        return [_validate_value(f"{name}[{index}]", item_spec, item) for index, item in enumerate(value)]

    if kind == "object":
        if not isinstance(value, dict):
            _fail(f"'{name}' must be an object.")
        return value

    return value
