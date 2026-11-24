import hashlib

def sign_v1(key: str, body: bytes) -> str:
    return hashlib.sha256(key.encode("utf-8") + body).hexdigest()

def sign_v2(key: str, method: str, path: str, ts_sec: int, nonce: str, body: bytes) -> str:
    return "unimplemented"
