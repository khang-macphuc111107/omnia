"""Active Production Events DLQ Writer (wired by config/production_wiring.json)."""
class DeadLetterOverflowError(RuntimeError):
    pass

def push_dead_letter(dlq_queue: list, event: dict, max_size: int = 100):
    if len(dlq_queue) >= max_size:
        # DEFECT: silently drops event instead of raising DeadLetterOverflowError
        return None
    dlq_queue.append(event)
    return len(dlq_queue)
