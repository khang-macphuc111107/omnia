def mock_push_dlq_2(dlq_queue: list, event: dict, max_size: int = 10):
    if len(dlq_queue) >= max_size:
        return None
    dlq_queue.append(event)
