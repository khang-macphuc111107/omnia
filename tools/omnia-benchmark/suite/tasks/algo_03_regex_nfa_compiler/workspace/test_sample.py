"""Basic sanity tests for the Thompson NFA / PikeVM regex engine."""

from solution import RegexSyntaxError, compile_pattern


def test_basic_captures_and_alternation() -> None:
    p = compile_pattern(r"(ab|a)b")
    m = p.fullmatch("ab")
    assert m is not None
    assert m.span == (0, 2)
    assert m.group(0) == "ab"
    assert m.group(1) == "a"
    assert m.groups() == ("a",)


def test_search_and_findall() -> None:
    p = compile_pattern(r"\d+")
    m = p.search("id=42, next=108")
    assert m is not None and m.span == (3, 5) and m.group(0) == "42"
    assert p.findall("id=42, next=108") == ["42", "108"]


def test_syntax_error() -> None:
    try:
        compile_pattern("(abc")
    except RegexSyntaxError:
        pass
    else:
        raise AssertionError("Expected RegexSyntaxError for unbalanced '('")


if __name__ == "__main__":
    test_basic_captures_and_alternation()
    test_search_and_findall()
    test_syntax_error()
    print("All sample tests passed!")
