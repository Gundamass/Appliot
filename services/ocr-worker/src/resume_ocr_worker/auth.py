import hmac

from fastapi import HTTPException, status


def require_bearer_token(authorization: str | None, expected_token: str) -> None:
    if authorization is None or not authorization.startswith("Bearer "):
        raise _unauthorized()

    presented_token = authorization.removeprefix("Bearer ")
    if not presented_token or not hmac.compare_digest(presented_token, expected_token):
        raise _unauthorized()


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized.",
        headers={"WWW-Authenticate": "Bearer"},
    )
