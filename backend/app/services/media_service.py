# app/services/media_service.py
"""Save and load an image that belongs to a database row.

MinIO is the primary store: the bytes go there and the row records the object
key. When the store is unreachable the bytes go into the row's BYTEA column
instead, so a stored alert never loses its picture. Reads prefer the key and
fall back to the bytes - which is also how rows from before MinIO keep working.
"""

import logging
from typing import Any, Optional

from app.core.database import db_manager
from app.services.object_store import object_store

logger = logging.getLogger(__name__)

# (table, id column, key column, bytes column) for every stored image.
EVENT_FRAME = ("fire_event", "event_id", "frame_key", "frame_jpeg")


async def save_image(kind: tuple, row_id: Any, key: str, data: Optional[bytes]) -> Optional[str]:
    """Store ``data`` for the row; returns the object key, or None if it went to Postgres."""
    if not data:
        return None
    table, id_column, key_column, bytes_column = kind
    if await object_store.put_bytes(key, data, "image/jpeg"):
        await db_manager.execute_query(
            f"UPDATE {table} SET {key_column} = $2 WHERE {id_column} = $1", (row_id, key)
        )
        return key
    logger.warning("MinIO unavailable; keeping %s %s in Postgres.", table, row_id)
    await db_manager.execute_query(
        f"UPDATE {table} SET {bytes_column} = $2 WHERE {id_column} = $1", (row_id, data)
    )
    return None


async def load(key: Optional[str], fallback: Optional[bytes]) -> Optional[bytes]:
    """The object behind ``key``, or the row's own bytes when there is none or it fails."""
    if key:
        data = await object_store.get_bytes(key)
        if data:
            return data
    return bytes(fallback) if fallback else None


async def load_image(kind: tuple, row_id: Any) -> Optional[bytes]:
    table, id_column, key_column, bytes_column = kind
    row = await db_manager.execute_query(
        f"SELECT {key_column}, {bytes_column} FROM {table} WHERE {id_column} = $1",
        (row_id,),
        fetch_one=True,
    )
    if not row:
        return None
    return await load(row[key_column], row[bytes_column])
