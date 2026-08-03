from __future__ import annotations

import importlib.util
import unittest


TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None


@unittest.skipUnless(TORCH_AVAILABLE, "torch is installed by the cpu/cuda/rocm extra")
class ModelTests(unittest.TestCase):
    def test_masked_mean_pool_excludes_padding_tokens(self) -> None:
        import torch

        from grimodex_lfm_eval.model import masked_mean_pool

        hidden = torch.tensor(
            [
                [
                    [1.0, 2.0],
                    [3.0, 4.0],
                    [100.0, 200.0],
                ]
            ]
        )
        attention_mask = torch.tensor([[1, 1, 0]])

        pooled = masked_mean_pool(hidden, attention_mask)

        torch.testing.assert_close(pooled, torch.tensor([[2.0, 3.0]]))

    def test_masked_mean_pool_rejects_all_padding(self) -> None:
        import torch

        from grimodex_lfm_eval.model import masked_mean_pool

        with self.assertRaises(ValueError):
            masked_mean_pool(torch.ones((1, 2, 3)), torch.zeros((1, 2)))


if __name__ == "__main__":
    unittest.main()
