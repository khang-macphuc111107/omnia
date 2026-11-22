class DeadLetterOverflowError(RuntimeError):
    pass
def enqueue_dlq_10(queue: list, item: dict, limit: int = 100) -> bool:
    if len(queue) >= limit:
        raise DeadLetterOverflowError("queue full")
    queue.append(item)
    return True
