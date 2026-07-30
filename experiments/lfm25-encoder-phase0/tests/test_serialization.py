from __future__ import annotations

import unittest

from grimodex_lfm_eval.serialization import (
    canonical_json,
    serialize_impact_input,
    serialize_relevance_input,
)


class SerializationTests(unittest.TestCase):
    def test_canonical_json_is_sorted_compact_and_unicode_preserving(self) -> None:
        payload = {
            "changes": [{"new": "新", "old": "旧"}],
            "entry_name": "朱音",
            "change_id": "change-01",
        }

        serialized = canonical_json(payload)

        self.assertEqual(
            serialized,
            '{"change_id":"change-01","changes":[{"new":"新","old":"旧"}],"entry_name":"朱音"}',
        )

    def test_relevance_input_snapshot(self) -> None:
        self.assertEqual(
            serialize_relevance_input("記憶の条件", "朱紐に触れると記憶が流れ込む。"),
            "[QUERY]\n記憶の条件\n\n[CANDIDATE]\n朱紐に触れると記憶が流れ込む。",
        )

    def test_impact_input_snapshot(self) -> None:
        self.assertEqual(
            serialize_impact_input(
                {"entry_name": "朱音", "change_id": "change-01"},
                "朱音は剣を握ったことがない。",
            ),
            (
                "[CODEX_CHANGE]\n"
                '{"change_id":"change-01","entry_name":"朱音"}'
                "\n\n[SCENE]\n朱音は剣を握ったことがない。"
            ),
        )


if __name__ == "__main__":
    unittest.main()
