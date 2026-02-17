#!/usr/bin/env python3
"""memU SillyTavern local bridge (memU v1.4+)

Protocol (newline-delimited JSON on stdin/stdout):
  Request:  {"id":"...","op":"health"|"memorize"|"list_categories", "payload":{...}}
  Response: {"id":"...","ok":true, "result":...} OR {"id":"...","ok":false,"error":"..."}

Notes:
- Designed to be launched as a long-running daemon. The Node plugin keeps it alive.
- Keeps MemoryService instances in-process so in-memory DB persists across requests.
- Adds a custom user model supporting user_id + agent_id so SillyTavern can scope memories per character.
- Forces conversation preprocess prompt to "" (disabled) unless explicitly provided.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import traceback
from typing import Any, Dict, Optional
from uuid import uuid4

# Silence noisy libs that might write to stdout
import logging
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

try:
    from pydantic import BaseModel
    from memu.app.service import MemoryService
except Exception as e:  # pragma: no cover
    # If memU import fails, we can still respond to health with error.
    BaseModel = object  # type: ignore
    MemoryService = None  # type: ignore
    _IMPORT_ERROR = e
else:
    _IMPORT_ERROR = None


class STUserModel(BaseModel):
    user_id: Optional[str] = None
    agent_id: Optional[str] = None


SERVICES: Dict[str, Any] = {}


def _json_default(obj: Any):
    """Best-effort JSON serializer for memU return types."""
    try:
        # Pydantic v2
        if hasattr(obj, "model_dump") and callable(getattr(obj, "model_dump")):
            return obj.model_dump()
        # Pydantic v1
        if hasattr(obj, "dict") and callable(getattr(obj, "dict")):
            return obj.dict()
        # Datetime-like (pendulum DateTime, datetime.datetime, etc.)
        if hasattr(obj, "isoformat") and callable(getattr(obj, "isoformat")):
            return obj.isoformat()
        # Fallback: stringify
        return str(obj)
    except Exception:
        return str(obj)


def _safe_err(e: BaseException) -> str:
    return f"{type(e).__name__}: {e}"


def _ensure_dir(path: str) -> None:
    if not path:
        return
    os.makedirs(path, exist_ok=True)


def _write_json(path: str, obj: Any) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def _normalize_conversation(conv: Any) -> Any:
    """Best-effort normalize SillyTavern messages for memU."""
    if not isinstance(conv, list):
        return conv
    out = []
    for m in conv:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "participant":
            role = "user"
        out.append({
            "role": role or "unknown",
            "name": m.get("name"),
            "content": m.get("content") or "",
        })
    return out


def _get_service(service_key: str, payload: Dict[str, Any]) -> Any:
    if _IMPORT_ERROR is not None or MemoryService is None:
        raise RuntimeError(f"memU import failed: {_safe_err(_IMPORT_ERROR)}")

    svc = SERVICES.get(service_key)
    if svc is not None:
        return svc

    # Copy config dicts so we can safely mutate
    llm_profiles = payload.get("llm_profiles") or {}
    blob_config = dict(payload.get("blob_config") or {})
    database_config = dict(payload.get("database_config") or {})
    memorize_config = dict(payload.get("memorize_config") or {})
    retrieve_config = dict(payload.get("retrieve_config") or {})

    # Disable conversation preprocess prompt unless explicitly set.
    mpp = dict(memorize_config.get("multimodal_preprocess_prompts") or {})
    if "conversation" not in mpp:
        mpp["conversation"] = ""
    memorize_config["multimodal_preprocess_prompts"] = mpp

    user_config = payload.get("user_config") or {}
    # Force STUserModel so agent_id is allowed.
    user_config = {**user_config, "model": STUserModel}

    svc = MemoryService(
        llm_profiles=llm_profiles,
        blob_config=blob_config,
        database_config=database_config,
        memorize_config=memorize_config,
        retrieve_config=retrieve_config,
        user_config=user_config,
    )

    SERVICES[service_key] = svc
    return svc


async def _op_health(payload: Dict[str, Any]) -> Dict[str, Any]:
    if _IMPORT_ERROR is not None:
        return {"status": "error", "error": _safe_err(_IMPORT_ERROR)}
    return {"status": "ok"}


async def _op_memorize(payload: Dict[str, Any]) -> Dict[str, Any]:
    service_key = payload.get("service_key") or "default"
    svc = _get_service(service_key, payload)

    user = payload.get("user") or {}
    blob_cfg = payload.get("blob_config") or {}
    resources_dir = blob_cfg.get("resources_dir") or payload.get("resources_dir") or ""
    if not resources_dir:
        # Fall back to a temp dir near cwd
        resources_dir = os.path.join(os.getcwd(), "memu_resources")
    _ensure_dir(resources_dir)

    conversation = _normalize_conversation(payload.get("conversation"))
    # memU conversation formatter expects JSON list/dict.
    fname = f"st_conversation_{int(time.time()*1000)}_{uuid4().hex[:8]}.json"
    local_path = os.path.join(resources_dir, fname)
    _write_json(local_path, conversation)

    # memU v1.4 signature
    result = await svc.memorize(resource_url=local_path, modality="conversation", user=user)
    if hasattr(result, "model_dump") and callable(getattr(result, "model_dump")):
        result = result.model_dump()
    elif hasattr(result, "dict") and callable(getattr(result, "dict")):
        result = result.dict()
    return {"result": result}


async def _op_list_categories(payload: Dict[str, Any]) -> Dict[str, Any]:
    service_key = payload.get("service_key") or "default"
    svc = _get_service(service_key, payload)
    where = payload.get("user") or {}
    result = await svc.list_memory_categories(where=where)
    if hasattr(result, "model_dump") and callable(getattr(result, "model_dump")):
        result = result.model_dump()
    elif hasattr(result, "dict") and callable(getattr(result, "dict")):
        result = result.dict()
    cats = result.get("categories") if isinstance(result, dict) else None
    return {"categories": cats or []}


async def _handle(req: Dict[str, Any]) -> Dict[str, Any]:
    rid = req.get("id")
    op = req.get("op")
    payload = req.get("payload") or {}

    if not rid:
        return {"id": None, "ok": False, "error": "Missing id"}

    try:
        if op == "health":
            out = await _op_health(payload)
        elif op == "memorize":
            out = await _op_memorize(payload)
        elif op == "list_categories":
            out = await _op_list_categories(payload)
        else:
            return {"id": rid, "ok": False, "error": f"Unknown op: {op}"}
        return {"id": rid, "ok": True, **out}
    except BaseException as e:
        # IMPORTANT: keep the daemon alive; return error instead of crashing.
        err = _safe_err(e)
        tb = traceback.format_exc(limit=8)
        logging.error("bridge op failed: %s\n%s", err, tb)
        return {"id": rid, "ok": False, "error": err}


async def main() -> None:
    # Drain stdin line-by-line (Node sends one JSON per line)
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            resp = {"id": None, "ok": False, "error": f"Bad JSON: {_safe_err(e)}"}
            print(json.dumps(resp, ensure_ascii=False, default=_json_default), flush=True)
            continue

        resp = await _handle(req if isinstance(req, dict) else {})
        print(json.dumps(resp, ensure_ascii=False, default=_json_default), flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
