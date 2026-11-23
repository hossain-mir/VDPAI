"""Safe arithmetic evaluation (AST whitelist, no ``eval``)."""

from __future__ import annotations

import ast
import math

from backend.core.errors import ToolError, ValidationError

MAX_EXPRESSION = 240
MAX_RESULT = 1e100
MAX_POWER = 512

_ALLOWED_FUNCTIONS = {
    name: getattr(math, name)
    for name in (
        "sqrt", "cbrt", "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
        "sinh", "cosh", "tanh", "log", "log2", "log10", "exp", "pow",
        "floor", "ceil", "fabs", "factorial", "gcd", "lcm", "degrees", "radians",
        "hypot", "trunc", "remainder", "dist", "comb", "perm",
    )
    if hasattr(math, name)
}
_ALLOWED_FUNCTIONS.update({"abs": abs, "round": round, "min": min, "max": max})
_ALLOWED_CONSTANTS = {"pi": math.pi, "e": math.e, "tau": math.tau, "inf": math.inf}

_BIN_OPS = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.FloorDiv: lambda a, b: a // b,
    ast.Mod: lambda a, b: a % b,
    ast.Pow: lambda a, b: a ** b,
}
_UNARY_OPS = {ast.UAdd: lambda a: +a, ast.USub: lambda a: -a}


def _evaluate(node: ast.AST, depth: int = 0) -> float | int:
    if depth > 24:
        raise ToolError("Expression is nested too deeply.")
    if isinstance(node, ast.Expression):
        return _evaluate(node.body, depth + 1)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ToolError("Only numeric constants are allowed.")
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
        left = _evaluate(node.left, depth + 1)
        right = _evaluate(node.right, depth + 1)
        if isinstance(node.op, ast.Pow) and abs(right) > MAX_POWER:
            raise ToolError("Exponent is too large.")
        result = _BIN_OPS[type(node.op)](left, right)
        if abs(result) > MAX_RESULT:
            raise ToolError("Result is too large.")
        return result
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _UNARY_OPS[type(node.op)](_evaluate(node.operand, depth + 1))
    if isinstance(node, ast.Name) and node.id in _ALLOWED_CONSTANTS:
        return _ALLOWED_CONSTANTS[node.id]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        function = _ALLOWED_FUNCTIONS.get(node.func.id)
        if function is None:
            raise ToolError(f"Function '{node.func.id}' is not allowed.")
        if node.keywords:
            raise ToolError("Keyword arguments are not supported.")
        args = [_evaluate(arg, depth + 1) for arg in node.args]
        if len(args) > 8:
            raise ToolError("Too many arguments.")
        return function(*args)
    raise ToolError("Unsupported expression element.")


def calculate(expression: str) -> dict:
    if not isinstance(expression, str) or not expression.strip():
        raise ValidationError("expression must be a non-empty string.")
    expression = expression.strip().replace("×", "*").replace("÷", "/").replace("^", "**")
    if len(expression) > MAX_EXPRESSION:
        raise ValidationError(f"Expression is limited to {MAX_EXPRESSION} characters.")
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        raise ValidationError("Invalid mathematical expression.") from None
    value = _evaluate(tree)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise ToolError("Result is not a finite number.")
        if value.is_integer() and abs(value) < 1e16:
            value = int(value)
        else:
            value = round(value, 10)
    return {"expression": expression, "result": value}
