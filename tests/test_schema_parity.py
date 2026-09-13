"""The CLI's base columns must equal the web app's combined CSV, name for name, in order."""
import os
import re

from lemonsqueeze.schema import BASE_COLUMNS, COLUMNS, STUDY_COLUMNS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def web_combined_headers():
    js = open(os.path.join(ROOT, "web", "app.js"), encoding="utf-8").read()
    start = js.index("function combinedToCSV")
    block = js[start:js.index("const rows = [];", start)]
    return re.findall(r'"([a-z_0-9]+)"', block.split("const headers = [")[1].split("];")[0])


def test_base_columns_match_web_export():
    assert web_combined_headers() == BASE_COLUMNS


def test_no_duplicate_column_names():
    assert len(COLUMNS) == len(set(COLUMNS))
    assert not set(STUDY_COLUMNS) & set(BASE_COLUMNS)


def test_query_is_last_base_column():
    assert BASE_COLUMNS[-1] == "query"
    assert BASE_COLUMNS[-2] == "row_type"
