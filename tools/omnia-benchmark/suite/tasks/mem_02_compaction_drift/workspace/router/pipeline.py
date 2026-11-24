class DispatchPipeline:
    def process_batch(self, events: list[dict], seed: str | None = None) -> dict:
        return {"accepted": [], "rejected": [], "deduped_count": 0, "digest": ""}

    def backoff_ms(self, attempt: int, seed: str | None = None) -> int:
        return 0
