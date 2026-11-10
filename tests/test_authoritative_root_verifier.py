"""Regression tests for the authoritative-root source verifier.

These tests intentionally exercise source-shape adversarial cases rather than
the live Tauri runtime.  The verifier is a static guard, so its most important
property is that one capability can only be satisfied by its exact command and
that inactive/commented declarations cannot provide evidence.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
VERIFIER_PATH = ROOT / "scripts" / "verify-authoritative-root-contract.py"
SPEC = importlib.util.spec_from_file_location("authoritative_root_verifier", VERIFIER_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import bootstrap
    raise RuntimeError(f"unable to load verifier at {VERIFIER_PATH}")
VERIFIER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = VERIFIER
SPEC.loader.exec_module(VERIFIER)


def command(name: str, storage_method: str, *, attributes: str = "") -> str:
    """Return a minimal active Tauri command declaration for a fixture."""

    return (
        f"#[tauri::command]\n"
        f"{attributes}"
        f"pub fn {name}(state: State<'_, AppState>, request: Request) {{\n"
        f"    state.storage.{storage_method}(request);\n"
        f"}}\n"
    )


def registered(*names: str) -> str:
    entries = "\n".join(f"        {name}," for name in names)
    return f"tauri::generate_handler![\n{entries}\n    ]"


class AuthoritativeRootVerifierTests(unittest.TestCase):
    def test_exact_command_is_required_not_a_neighbouring_name(self) -> None:
        source = command("task_dependency_create", "create_task_dependency")
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_dependency_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertTrue(
            any(
                finding.startswith("task.create: missing native")
                and "task_create" in finding
                for finding in missing
            ),
            missing,
        )

    def test_exact_storage_delegation_is_required(self) -> None:
        source = command("task_create", "create_task_dependency")
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertTrue(
            any(
                finding.startswith("task.create: task_create does not delegate")
                for finding in missing
            ),
            missing,
        )

    def test_storage_receiver_must_be_the_command_state_not_an_alias(self) -> None:
        source = """
        #[tauri::command]
        pub fn task_create(state: State<'_, AppState>, request: Request) {
            other.state.storage.create_task(request);
        }
        """
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertTrue(
            any(
                finding.startswith("task.create: task_create does not delegate")
                for finding in missing
            ),
            missing,
        )

    def test_exact_command_must_declare_state_parameter(self) -> None:
        source = """
        #[tauri::command]
        pub fn task_create(request: Request) {
            let state = make_fake_state();
            state.storage.create_task(request);
        }
        """
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertIn(
            "task.create: task_create must declare a standalone state parameter",
            missing,
        )

    def test_local_state_binding_cannot_donate_native_storage_call(self) -> None:
        source = """
        #[tauri::command]
        pub fn task_create(state: State<'_, AppState>, request: Request) {
            {
                let state = make_fake_state();
                state.storage.create_task(request);
            }
        }
        """
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertIn(
            "task.create: task_create shadows the native state receiver",
            missing,
        )

    def test_mut_state_parameter_is_allowed(self) -> None:
        source = """
        #[tauri::command]
        pub fn task_create(mut state: State<'_, AppState>, request: Request) {
            state.storage.create_task(request);
        }
        """
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create"),
            require_api=True,
        )

        self.assertIn("task.create=task_create", passed)
        self.assertNotIn(
            "task.create: task_create must declare a standalone state parameter",
            missing,
        )

    def test_unterminated_command_body_fails_closed(self) -> None:
        source = """
        #[tauri::command]
        pub fn task_create(state: State<'_, AppState>, request: Request) {
            state.storage.create_task(request);
        """
        definitions = VERIFIER.parse_command_definitions(source)
        self.assertEqual(["task_create"], [definition.name for definition in definitions])
        self.assertIsNone(definitions[0].body)

        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create"),
            require_api=True,
        )
        self.assertNotIn("task.create=task_create", passed)
        self.assertIn(
            "task.create: unable to extract body for command task_create",
            missing,
        )

    def test_nested_helper_cannot_donate_the_storage_delegation(self) -> None:
        source = """
        #[tauri::command]
        pub fn task_create(state: State<'_, AppState>, request: Request) {
            fn helper() {
                state.storage.create_task(request);
            }
        }
        """
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertTrue(
            any(
                finding.startswith("task.create: task_create does not delegate")
                for finding in missing
            ),
            missing,
        )

    def test_additional_storage_call_cannot_hide_behind_an_exact_call(self) -> None:
        source = """
        #[tauri::command]
        pub fn task_create(state: State<'_, AppState>, request: Request) {
            state.storage.create_task(request);
            state.storage.read_task(request);
        }
        """
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertTrue(
            any(
                finding.startswith("task.create: task_create contains additional or nested storage calls")
                for finding in missing
            ),
            missing,
        )

    def test_body_is_not_aggregated_from_a_neighbouring_command(self) -> None:
        source = (
            command("task_create", "create_task_dependency")
            + command("task_dependency_create", "create_task")
        )
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create", "task_dependency_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertTrue(
            any(
                finding.startswith("task.create: task_create does not delegate")
                for finding in missing
            ),
            missing,
        )

    def test_comments_strings_and_definitely_inactive_cfg_are_not_commands(self) -> None:
        source = """
        /* #[tauri::command]
        pub fn task_create() { state.storage.create_task(request); }
        */
        const TEXT: &str = "#[tauri::command] fn task_create() { state.storage.create_task(request); }";
        #[cfg(any())]
        #[tauri::command]
        pub fn task_create() { state.storage.create_task(request); }
        #[cfg(test)]
        #[tauri::command]
        pub fn task_dependency_create() { state.storage.create_task_dependency(request); }
        """

        definitions = VERIFIER.parse_command_definitions(source)
        self.assertEqual([], definitions)

    def test_nested_block_comments_are_not_commands(self) -> None:
        source = """
        /* outer comment
           /* nested comment with a fake command
           #[tauri::command]
           pub fn task_create() { state.storage.create_task(request); }
           */
           still inside the outer comment
        */
        """

        definitions = VERIFIER.parse_command_definitions(source)
        self.assertEqual([], definitions)

    def test_unterminated_raw_literal_fails_closed(self) -> None:
        source = r'''
        const TEXT: &str = r###"unterminated
        #[tauri::command]
        pub fn task_create() { state.storage.create_task(request); }
        '''

        definitions = VERIFIER.parse_command_definitions(source)
        self.assertEqual([], definitions)

    def test_raw_and_byte_literals_with_braces_do_not_break_body_extraction(self) -> None:
        source = r'''
        #[tauri::command]
        pub fn task_create() {
            let raw = br###"/* { } #[tauri::command] */"###;
            let bytes = b"escaped \" braces { }";
            let character = '\'';
            let lifetime: &'static str = "ok";
            state.storage.create_task(request);
        }
        '''

        definitions = VERIFIER.parse_command_definitions(source)
        self.assertEqual(["task_create"], [definition.name for definition in definitions])
        self.assertIn("state.storage.create_task", definitions[0].body or "")

    def test_active_command_survives_masking_and_cfg_filtering(self) -> None:
        source = (
            "#[cfg(feature = \"native\")]\n"
            + command("task_create", "create_task")
        )

        definitions = VERIFIER.parse_command_definitions(source)
        self.assertEqual(["task_create"], [definition.name for definition in definitions])

    def test_inactive_cfg_with_outer_attributes_cannot_donate_commands(self) -> None:
        source = """
        #[cfg(any())]
        #[inline(always)]
        pub mod disabled_fixtures {
            #[tauri::command]
            pub fn task_create() { state.storage.create_task(request); }
        }

        #[cfg(test)]
        #[allow(dead_code)]
        #[tauri::command]
        pub fn task_dependency_create() {
            state.storage.create_task_dependency(request);
        }
        """

        definitions = VERIFIER.parse_command_definitions(source)
        self.assertEqual([], definitions)

        self.assertEqual(
            set(),
            VERIFIER.parse_registered_commands(
                """
                #[cfg(any())]
                #[inline(always)]
                mod disabled_handler {
                    tauri::generate_handler![task_create,]
                }
                #[cfg(test)]
                #[allow(dead_code)]
                tauri::generate_handler![task_dependency_create,]

                tauri::generate_handler![]
                """
            ),
        )

    def test_inactive_impl_and_trait_ranges_cannot_donate_commands(self) -> None:
        source = """
        #[cfg(any())]
        impl Disabled {
            #[tauri::command]
            pub fn task_create(state: State<'_, AppState>, request: Request) {
                state.storage.create_task(request);
            }
        }

        #[cfg(any())]
        trait DisabledTrait {
            #[tauri::command]
            fn task_dependency_create(state: State<'_, AppState>, request: Request) {
                state.storage.create_task_dependency(request);
            }
        }
        """

        self.assertEqual([], VERIFIER.parse_command_definitions(source))

    def test_nested_definitely_inactive_cfg_predicates_cannot_donate_commands(self) -> None:
        inactive_expressions = (
            "all(any(), feature = \"native\")",
            "all(test, feature = \"native\")",
            "any(test, false)",
            "not(all())",
            "not(not(any()))",
        )
        for expression in inactive_expressions:
            with self.subTest(expression=expression):
                source = f"""
                #[cfg({expression})]
                #[tauri::command]
                pub fn task_create() {{
                    state.storage.create_task(request);
                }}
                """
                self.assertEqual([], VERIFIER.parse_command_definitions(source))

    def test_unknown_cfg_predicates_remain_eligible(self) -> None:
        active_expressions = (
            "any(feature = \"native\", false)",
            "not(any())",
            "all()",
            "all(not(test), feature = \"native\")",
        )
        for expression in active_expressions:
            with self.subTest(expression=expression):
                source = f"""
                #[cfg({expression})]
                #[tauri::command]
                pub fn task_create() {{
                    state.storage.create_task(request);
                }}
                """
                self.assertEqual(
                    ["task_create"],
                    [definition.name for definition in VERIFIER.parse_command_definitions(source)],
                )

    def test_similar_command_names_cannot_satisfy_exact_capability(self) -> None:
        source = (
            command("not_task_create", "create_task")
            + command("task_create_extra", "create_task")
            + command("taskish_create", "create_task")
        )
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("not_task_create", "task_create_extra", "taskish_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertTrue(
            any(
                finding.startswith("task.create: missing native")
                and "task_create" in finding
                for finding in missing
            ),
            missing,
        )

    def test_duplicate_active_command_definitions_fail_closed(self) -> None:
        source = command("task_create", "create_task") + command(
            "task_create", "create_task"
        )
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertTrue(
            any(
                finding.startswith("task.create: command task_create has 2 active definitions")
                for finding in missing
            ),
            missing,
        )

    def test_exact_command_must_be_registered(self) -> None:
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", command("task_create", "create_task"))],
            registered(),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertIn("task.create: command task_create is not registered", missing)

    def test_revision_reads_and_dependency_listing_are_required_capabilities(self) -> None:
        source = (
            command("goal_create", "create_goal")
            + command("task_create", "create_task")
            + command("starter_workflow_create", "create_starter_workflow")
        )
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("goal_create", "task_create", "starter_workflow_create"),
            require_api=True,
        )

        self.assertNotIn("goal.revision_read=goal_revision_read", passed)
        self.assertNotIn("task.revision_read=task_revision_read", passed)
        self.assertNotIn("task.dependency_list=task_dependency_list", passed)
        self.assertNotIn(
            "starter_workflow.revision_read=starter_workflow_revision_read", passed
        )
        for capability, command_name in (
            ("goal.revision_read", "goal_revision_read"),
            ("task.revision_read", "task_revision_read"),
            ("task.dependency_list", "task_dependency_list"),
            ("starter_workflow.revision_read", "starter_workflow_revision_read"),
        ):
            self.assertTrue(
                any(
                    finding.startswith(f"{capability}: missing native")
                    and command_name in finding
                    for finding in missing
                ),
                missing,
            )

    def test_registered_commands_support_single_line_handler(self) -> None:
        self.assertEqual(
            {"task_create", "task_read"},
            VERIFIER.parse_registered_commands(
                "tauri::generate_handler![task_create, task_read,]"
            ),
        )

    def test_duplicate_registered_command_entries_fail_closed(self) -> None:
        with self.assertRaisesRegex(
            AssertionError, "duplicate registered command entry: task_create"
        ):
            VERIFIER.parse_registered_commands(
                "tauri::generate_handler![task_create, task_create,]"
            )

    def test_multiple_active_handler_registrations_fail_closed(self) -> None:
        source = (
            "tauri::generate_handler![task_create,]\n"
            "tauri::generate_handler![task_read,]"
        )
        with self.assertRaisesRegex(
            AssertionError, "exactly one active generate_handler"
        ):
            VERIFIER.parse_registered_commands(source)

    def test_inactive_handler_registration_is_ignored(self) -> None:
        source = (
            "#[cfg(any())]\n"
            "tauri::generate_handler![task_create,]\n"
            "tauri::generate_handler![task_read,]"
        )
        self.assertEqual({"task_read"}, VERIFIER.parse_registered_commands(source))

    def test_handler_macros_in_comments_and_strings_are_not_registrations(self) -> None:
        source = (
            '// tauri::generate_handler![task_create,]\n'
            'const TEXT: &str = "tauri::generate_handler![task_create,]";\n'
            "tauri::generate_handler![task_read,]"
        )
        self.assertEqual({"task_read"}, VERIFIER.parse_registered_commands(source))

    def test_unterminated_handler_registration_fails_closed(self) -> None:
        with self.assertRaisesRegex(
            AssertionError, "unterminated tauri::generate_handler"
        ):
            VERIFIER.parse_registered_commands("tauri::generate_handler![task_create,")

    def test_exact_command_cannot_contain_direct_sql(self) -> None:
        source = """
        #[tauri::command]
        pub fn task_create(state: State<'_, AppState>, request: Request) {
            connection.execute(\"INSERT INTO tasks (id) VALUES (?1)\", params![id]);
            state.storage.create_task(request);
        }
        """
        passed, missing = VERIFIER.api_checks(
            [(ROOT / "fixture.rs", source)],
            registered("task_create"),
            require_api=True,
        )

        self.assertNotIn("task.create=task_create", passed)
        self.assertIn(
            "task.create: task_create contains direct SQL instead of storage delegation",
            missing,
        )

    def renderer_sql_findings(self, source: str) -> list[str]:
        with tempfile.TemporaryDirectory(dir=ROOT, prefix="authoritative-root-fixture-") as directory:
            fixture = Path(directory) / "goal-task-studio.tsx"
            fixture.write_text(source, encoding="utf-8")
            original_root = VERIFIER.RENDERER_ROOT
            VERIFIER.RENDERER_ROOT = Path(directory)
            try:
                return VERIFIER.renderer_direct_sql_findings()
            finally:
                VERIFIER.RENDERER_ROOT = original_root

    def test_jsx_select_tag_is_not_misclassified_as_direct_sql(self) -> None:
        """HTML controls must not donate a false SQL finding to the root gate."""

        self.assertEqual([], self.renderer_sql_findings(
            '<select aria-label="Task filter"></select>\n'
            '<label><span>Search tasks</span></label>\n'
            '<button>Select the previous goal</button>\n'
            'visited.delete(task.id);\n'
            'const tasks = [];\n'
            '<p>Import from tasks</p>\n'
        ))

    def test_renderer_sql_detects_statement_kinds_and_identifier_forms(self) -> None:
        statements = (
            "SELECT * FROM {table}",
            "INSERT INTO {table} (id) VALUES (1)",
            "REPLACE INTO {table} (id) VALUES (1)",
            "UPDATE {table} SET id = 2",
            "DELETE FROM {table}",
        )
        for root_table in VERIFIER.ROOT_TABLES:
            for table in (
                root_table, f'"{root_table}"', f'`{root_table}`',
                f'[{root_table}]', f'main.{root_table}',
                f'"main" . "{root_table}"',
            ):
                for statement in statements:
                    sql = statement.format(table=table)
                    with self.subTest(sql=sql):
                        findings = self.renderer_sql_findings(f"db.execute({sql!r});")
                        self.assertEqual(1, len(findings))
                        self.assertIn(":1: renderer SQL", findings[0])

    def test_renderer_sql_detects_joins_conflicts_and_comment_separators(self) -> None:
        statements = (
            "SELECT * FROM other JOIN tasks ON other.id = tasks.id",
            'SELECT * FROM other LEFT JOIN main."tasks" AS t ON t.id = other.id',
            "UPDATE OR IGNORE tasks SET id = 2",
            "UPDATE OR REPLACE [tasks] SET id = 2",
            "INSERT OR IGNORE INTO main.tasks (id) VALUES (1)",
            "SELECT * FROM /* root */ tasks",
            "SELECT * FROM -- root\ntasks",
            "UPDATE/* root */OR/* policy */IGNORE/* table */tasks SET id = 2",
            "DELETE/* verb */FROM/* table */tasks",
        )
        for sql in statements:
            with self.subTest(sql=sql):
                # Template literals retain multiline SQL and SQL comments.
                self.assertEqual(1, len(self.renderer_sql_findings(f"db.execute(`{sql}`);")))
        for identifier in ('"x;y"', '`x;y`', '[x;y]'):
            sql = f"SELECT {identifier} FROM tasks"
            with self.subTest(sql=sql):
                self.assertEqual(1, len(self.renderer_sql_findings(f"db.execute({sql!r});")))

    def test_renderer_sql_select_projection_subset(self) -> None:
        for sql in (
            'SELECT id FROM tasks',
            'SELECT id, profile_id FROM tasks',
            'SELECT "id", [profile_id] FROM "tasks"',
            'SELECT tasks.id, tasks.* FROM tasks',
            'SELECT DISTINCT id FROM tasks',
            'SELECT ALL id FROM tasks',
            'SELECT id AS task_id FROM tasks',
            'SELECT COUNT(*) AS total FROM tasks',
            'SELECT COALESCE(id, 0) FROM tasks',
            'SELECT other.id FROM other JOIN tasks ON tasks.id = other.id',
            'SELECT "x;y" FROM tasks',
        ):
            with self.subTest(sql=sql):
                self.assertEqual(1, len(self.renderer_sql_findings(f"db.execute({sql!r});")))

    def test_renderer_sql_does_not_treat_multiword_ui_copy_as_projection(self) -> None:
        for source in (
            "const label = 'Select a goal from tasks';",
            'const label = "Select a goal from tasks";',
            'const label = `Select a goal from tasks`;',
            "const label = 'Select the previous goal from tasks';",
        ):
            with self.subTest(source=source):
                self.assertEqual([], self.renderer_sql_findings(source))

    def test_renderer_sql_decodes_comment_newlines_without_shifting_source_lines(self) -> None:
        for source in (
            r'db.execute("SELECT * FROM -- comment\ntasks");',
            r'db.execute("SELECT * FROM -- comment\rtasks");',
            r'db.execute("-- comment\nSELECT * FROM tasks");',
            r'db.execute("SELECT * FROM\ttasks");',
        ):
            with self.subTest(source=source):
                findings = self.renderer_sql_findings(source)
                self.assertEqual(1, len(findings))
                self.assertIn(":1: renderer SQL", findings[0])
        # An escaped backslash followed by n is not a runtime newline.
        self.assertEqual([], self.renderer_sql_findings(
            r'db.execute("SELECT * FROM -- comment\\ntasks");'
        ))

    def test_renderer_sql_does_not_combine_literals_or_scan_comments(self) -> None:
        for source in (
            '// SELECT * FROM tasks\nconst safe = true;',
            '/* DELETE FROM tasks */ const safe = true;',
            'const a = "SELECT *"; const b = "FROM tasks";',
            'const a = `SELECT * FROM other; FROM tasks`;',
            'const a = `SELECT * FROM tasks_archive`;',
            'const a = `SELECT * FROM "tasks_archive"`;',
            'const a = `SELECT * FROM tasks.other`;',
            'const a = `SELECT * FROM "tasks"."other"`;',
            'const a = `SELECT \'FROM tasks\' FROM other`;',
            'const a = `SELECT * FROM other /* JOIN tasks */`;',
        ):
            with self.subTest(source=source):
                self.assertEqual([], self.renderer_sql_findings(source))

    def test_renderer_sql_reports_multiline_statement_source_line(self) -> None:
        findings = self.renderer_sql_findings(
            'const safe = true;\nconst sql = `\nSELECT * FROM tasks\n`;\n'
        )
        self.assertEqual(1, len(findings))
        self.assertIn(":3: renderer SQL", findings[0])


if __name__ == "__main__":  # pragma: no cover - direct invocation helper
    unittest.main()
