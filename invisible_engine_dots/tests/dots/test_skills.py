"""The Dot's skills: the built-in ones, its own, which wins, and what is no skill."""

from __future__ import annotations

from pathlib import Path

from fakes.local_computer import LocalComputer

from nanobot.dots.skills import BUILTIN_SKILLS_DIR, DOT_SKILLS_DIR, all_skills, builtin_skills, dot_skills, parse_skill


def skill_file(name: str, description: str, body: str = "Do it.") -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"


def write_own(tmp_path: Path, folder: str, text: str) -> None:
    path = tmp_path / "home" / "dot" / "skills" / folder / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class TestParse:
    def test_reads_the_name_and_the_description_of_the_frontmatter(self) -> None:
        assert parse_skill(skill_file("fares", "Find the cheapest fare."), "fares") == ("fares", "Find the cheapest fare.")
        assert parse_skill("---\r\nname: fares\r\ndescription: 'quoted'\r\n---\r\nbody", "fares") == ("fares", "quoted")

    def test_is_no_skill_without_a_frontmatter_a_description_or_the_folders_name(self) -> None:
        assert parse_skill("name: fares\ndescription: x\n", "fares") is None
        assert parse_skill(skill_file("fares", ""), "fares") is None
        assert parse_skill(skill_file("fares", "x"), "other") is None
        assert parse_skill(skill_file("fares", "x" * 1025), "fares") is None

    def test_takes_a_name_only_of_lowercase_letters_digits_and_single_hyphens(self) -> None:
        for name in ("Fares", "fa--res", "-fares", "fares-", "fa res", "x" * 65):
            assert parse_skill(skill_file(name, "x"), name) is None, name
        assert parse_skill(skill_file("fares-2", "x"), "fares-2") == ("fares-2", "x")


def test_every_built_in_skill_is_valid_and_teaches_the_browser_identities() -> None:
    skills = builtin_skills()
    assert [s.name for s in skills] == sorted(p.parent.name for p in BUILTIN_SKILLS_DIR.glob("*/SKILL.md"))
    browser = next(s for s in skills if s.name == "invisible-playwright")
    assert browser.source == "builtin" and browser.path.endswith("/skills/invisible-playwright/SKILL.md") and "nanobot" not in browser.path
    # It names the identity tools the Dot has, and leaves how a page is driven to the server's instructions.
    for tool in ("browser_identity_list", "browser_identity_create", "browser_identity_launch", "browser_identity_close"):
        assert tool in browser.content
    assert "browser server's instructions" in browser.content


async def test_the_dots_own_skills_are_read_from_its_computer_and_a_bad_one_is_left_out(tmp_path: Path) -> None:
    computer = LocalComputer(tmp_path)
    assert await dot_skills(computer) == []
    write_own(tmp_path, "login-to-shop", skill_file("login-to-shop", "Log in to the shop.", "Click Sign in."))
    write_own(tmp_path, "broken", "no frontmatter at all")
    (tmp_path / "home" / "dot" / "skills" / "empty").mkdir()
    (tmp_path / "home" / "dot" / "skills" / "loose.md").write_text(skill_file("loose", "x"), encoding="utf-8")

    skills = await dot_skills(computer)

    assert [(s.name, s.source, s.path) for s in skills] == [("login-to-shop", "dot", f"{DOT_SKILLS_DIR}/login-to-shop/SKILL.md")]
    assert "Click Sign in." in skills[0].content


async def test_a_skill_of_the_dots_own_replaces_a_built_in_one_of_the_same_name(tmp_path: Path) -> None:
    computer = LocalComputer(tmp_path)
    write_own(tmp_path, "invisible-playwright", skill_file("invisible-playwright", "My own way with the browser."))
    write_own(tmp_path, "aaa", skill_file("aaa", "First by name."))

    skills = await all_skills(computer)

    assert [s.name for s in skills] == sorted({"aaa", "invisible-playwright", *(s.name for s in builtin_skills())})
    mine = next(s for s in skills if s.name == "invisible-playwright")
    assert (mine.source, mine.description) == ("dot", "My own way with the browser.")
