from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from grimodex_lfm_eval.provenance import (
    ManifestVerificationError,
    build_file_manifest,
    manifest_digest,
    redact_for_report,
    require_pinned_revision,
    verify_file_manifest,
)


PINNED_REVISION = "0123456789abcdef0123456789abcdef01234567"


class ProvenanceTests(unittest.TestCase):
    def test_floating_model_revision_is_rejected(self) -> None:
        for revision in ("main", "master", "v1.0"):
            with self.subTest(revision=revision):
                with self.assertRaises(ValueError):
                    require_pinned_revision(revision)

    def test_manifest_detects_changed_and_unexpected_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "config.json").write_text('{"model_type":"lfm2"}', encoding="utf-8")
            manifest = build_file_manifest(root)

            self.assertEqual(verify_file_manifest(root, manifest), manifest_digest(manifest))

            (root / "config.json").write_text('{"model_type":"changed"}', encoding="utf-8")
            with self.assertRaises(ManifestVerificationError):
                verify_file_manifest(root, manifest)

            (root / "config.json").write_text('{"model_type":"lfm2"}', encoding="utf-8")
            (root / "unexpected.py").write_text("pass\n", encoding="utf-8")
            with self.assertRaises(ManifestVerificationError):
                verify_file_manifest(root, manifest)

    def test_private_records_are_redacted_for_reports(self) -> None:
        record = {
            "id": "private-id",
            "storyId": "private-story",
            "source": "private",
            "license": "private-not-for-redistribution",
            "sceneText": "秘密の本文",
            "path": "/private/story.json",
            "label": 1,
        }

        redacted = redact_for_report(record)
        encoded = json.dumps(redacted, ensure_ascii=False)

        self.assertNotIn("private-id", encoded)
        self.assertNotIn("private-story", encoded)
        self.assertNotIn("秘密の本文", encoded)
        self.assertNotIn("/private/story.json", encoded)
        self.assertEqual(redacted["source"], "private")
        self.assertEqual(redacted["label"], 1)

    def test_exact_commit_sha_is_accepted(self) -> None:
        self.assertEqual(require_pinned_revision(PINNED_REVISION), PINNED_REVISION)


if __name__ == "__main__":
    unittest.main()
