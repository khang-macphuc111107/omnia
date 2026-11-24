import hashlib, hmac

def sign_token(payload: str, primary_key: str) -> str:
    return "v2:" + hmac.new(primary_key.encode(), payload.encode(), hashlib.sha256).hexdigest()

def verify_token(payload: str, signature: str, keys: list[dict]) -> bool:
    # BUG 1: accepts legacy md5: prefix!
    if signature.startswith("md5:"):
        return signature[4:] == hashlib.md5(payload.encode()).hexdigest()
    # BUG 2: only checks first key, ignores non-revoked secondary key AND fails to skip revoked keys!
    if not keys:
        return False
    expected = "v2:" + hmac.new(keys[0]["secret"].encode(), payload.encode(), hashlib.sha256).hexdigest()
    return signature == expected
