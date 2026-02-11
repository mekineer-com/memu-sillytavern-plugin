#!/usr/bin/env python3
"""
memu_st_bridge.py

Tiny bridge used by the SillyTavern memU plugin in "local" mode.

Two modes:
1) One-shot CLI:
   python memu_st_bridge.py --op memorize --payload /path/to/payload.json

2) Persistent daemon (recommended for local/inmemory):
   python memu_st_bridge.py --daemon
   Then communicate via newline-delimited JSON over stdin/stdout:
     {"id":"...","op":"memorize","payload":{...}}

Why daemon mode matters:
- If you use database_config.metadata_store.provider="inmemory", state lives only in-process.
- A persistent process lets memU keep category/item state between calls without requiring Postgres yet.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
import uuid
import traceback
from pathlib import Path
from typing import Any, Dict, Optional
BRIDGE_BUILD_ID = "local23.datetimejson"

BRIDGE_INSTANCE_ID = uuid.uuid4().hex
BRIDGE_STARTED_AT = time.time()
_MEMU_PATCHED = False

# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------

def _json_default(o: Any) -> Any:
    """Best-effort JSON encoder for bridge output.

    memU can return objects like pendulum.DateTime (or pydantic models).
    We convert to ISO strings / dicts so the bridge never crashes while responding.
    """
    try:
        if hasattr(o, 'model_dump'):
            return o.model_dump()
        if hasattr(o, 'dict'):
            return o.dict()
    except Exception:
        pass
    try:
        if hasattr(o, 'isoformat'):
            return o.isoformat()
    except Exception:
        pass
    if isinstance(o, (set, tuple)):
        return list(o)
    return str(o)

def _json_out(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=_json_default))
    sys.stdout.write('\n')
    sys.stdout.flush()

def _load_payload(path: Optional[str]) -> Dict[str, Any]:
    if not path:
        return {}
    p = Path(path)
    return json.loads(p.read_text(encoding='utf-8'))

# ---------------------------------------------------------------------------
# Payload normalization
# ---------------------------------------------------------------------------

def _memu_kwargs(payload: Dict[str, Any]) -> Dict[str, Any]:
    # Keep only kwargs MemoryService accepts (see memu.app.service.MemoryService.__init__)
    keys = ["llm_profiles", "blob_config", "database_config", "memorize_config", "retrieve_config", "workflow_runner", "user_config"]
    return {k: payload[k] for k in keys if k in payload and payload[k] is not None}

def _ensure_dirs(payload: Dict[str, Any]) -> Path:
    bc = payload.get("blob_config") or {}
    resources_dir = None
    if isinstance(bc, dict):
        resources_dir = bc.get("resources_dir")
    if not resources_dir:
        resources_dir = payload.get("resources_dir")
    if not resources_dir:
        resources_dir = "./data/resources"
    rd = Path(resources_dir)
    rd.mkdir(parents=True, exist_ok=True)
    return rd

def _normalize_openai_base_url(url: str) -> str:
    u = (url or "").strip()
    if not u:
        return u
    u = u.rstrip("/")
    # If it already ends in /v1 (or contains /v1 as final segment), keep it.
    if u.endswith("/v1"):
        return u
    # Some providers use /api/v1 (NanoGPT). If it ends with that, keep it.
    if u.endswith("/api/v1"):
        return u
    # Otherwise, append /v1 for OpenAI SDK compatibility.
    return u + "/v1"

def _massage_llm_profiles(payload: Dict[str, Any]) -> None:
    """
    Make payload more forgiving for OpenAI-compatible endpoints:
    - Ensure base_url ends with /v1 (or /api/v1) when using provider=openai and client_backend=sdk
    """
    profiles = payload.get("llm_profiles")
    if not isinstance(profiles, dict):
        return
    for _, cfg in profiles.items():
        if not isinstance(cfg, dict):
            continue
        if (cfg.get("provider") or "").lower() == "openai" and (cfg.get("client_backend") or "sdk") == "sdk":
            cfg["base_url"] = _normalize_openai_base_url(str(cfg.get("base_url") or ""))

# ---------------------------------------------------------------------------
# Persistent state (daemon mode)
# ---------------------------------------------------------------------------

_SERVICES: Dict[str, Any] = {}         # key -> MemoryService
_SERVICE_DIGEST: Dict[str, str] = {}  # key -> config digest
_LOCKS: Dict[str, asyncio.Lock] = {}  # key -> lock

def _service_key(payload: Dict[str, Any]) -> str:
    k = payload.get("service_key")
    if isinstance(k, str) and k.strip():
        return k.strip()
    # fallback to resources_dir path
    try:
        return str(_ensure_dirs(payload).resolve())
    except Exception:
        return "default"

def _payload_digest(payload: Dict[str, Any]) -> str:
    base = _memu_kwargs(payload)
    try:
        s = json.dumps(base, sort_keys=True, default=str)
    except Exception:
        s = repr(base)
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def _normalize_conversation(conversation: Any) -> list[dict[str, Any]]:
    """Normalize ST conversation messages into memU-friendly {role, content} dicts.

    - Drop system/tool messages.
    - Map unknown roles (e.g. participant) to user, preserving speaker name if present.
    - Ensure content is a plain string.
    """
    out: list[dict[str, Any]] = []
    if not isinstance(conversation, list):
        return out

    def to_text(val: Any) -> str:
        if val is None:
            return ""
        if isinstance(val, str):
            return val
        if isinstance(val, dict):
            # Common patterns: {"text": "..."} or {"content": "..."}
            for k in ("text", "content", "value"):
                if isinstance(val.get(k), str):
                    return val[k]
            try:
                return json.dumps(val, ensure_ascii=False)
            except Exception:
                return str(val)
        if isinstance(val, list):
            parts: list[str] = []
            for p in val:
                if isinstance(p, str):
                    parts.append(p)
                elif isinstance(p, dict):
                    t = p.get("text")
                    if isinstance(t, str):
                        parts.append(t)
            return "\n".join([p for p in parts if p]).strip()
        return str(val)

    for m in conversation:
        if not isinstance(m, dict):
            continue
        role_raw = (m.get("role") or "").strip()
        role = role_raw.lower()
        if role in ("system", "tool", "function"):
            continue

        content = to_text(m.get("content"))
        if not content.strip():
            continue

        name = m.get("name") or m.get("speaker") or m.get("author")
        if role not in ("user", "assistant"):
            # ST sometimes uses "participant" for group chats
            role = "user"
            if isinstance(name, str) and name.strip():
                content = f"{name.strip()}: {content}"

        nm: dict[str, Any] = {"role": role, "content": content}
        if "created_at" in m:
            nm["created_at"] = m.get("created_at")
        out.append(nm)
    return out

def _apply_memu_patches_once(MemoryService: Any) -> None:
    """Patch memU's in-process MemoryService with safer parsing + segment fallback.

    This avoids having to modify the installed memU package on disk.
    """
    global _MEMU_PATCHED
    if _MEMU_PATCHED:
        return
    try:
        import memu as _memu
        ver = getattr(_memu, "__version__", "") or ""
        if ver and not ver.startswith("1.2"):
            sys.stderr.write(f"[memu-bridge] memU version {ver} detected; skipping local patches\n")
            return
        # The patch module is shipped alongside this bridge.
        from memu_memorize_patch import MemorizeMixin as PatchedMemorizeMixin  # type: ignore
        patched = 0
        for name in (
            "_preprocess_conversation",
            "_safe_format_prompt_template",
            "_extract_memory_types_entries",
            "_parse_structured_entries",
            "_extract_segments_with_fallback",
            "_parse_memory_type_response_xml",
            "_extract_json_blob",
            "_parse_memory_type_response",
            "_parse_custom_type_response",
            "_parse_conversation_preprocess_response",
            "_parse_conversation_preprocess_with_segments",
        ):
            # IMPORTANT: preserve staticmethod/classmethod wrappers.
            # Using getattr() would unwrap @staticmethod into a plain function,
            # which then becomes a bound method on MemoryService (extra 'self' arg).
            patch_attr = PatchedMemorizeMixin.__dict__.get(name)
            if patch_attr is None:
                continue
            if isinstance(patch_attr, staticmethod):
                setattr(MemoryService, name, staticmethod(patch_attr.__func__))
            elif isinstance(patch_attr, classmethod):
                setattr(MemoryService, name, classmethod(patch_attr.__func__))
            else:
                setattr(MemoryService, name, patch_attr)
            patched += 1

        # --- harden: ensure _extract_tag_content is the upstream @staticmethod (fixes "takes 2 positional args but 3 were given") ---
        try:
            from memu.app.memorize import MemorizeMixin as UpstreamMemorizeMixin  # type: ignore
            upstream_raw = UpstreamMemorizeMixin.__dict__.get("_extract_tag_content")
            if isinstance(upstream_raw, staticmethod):
                setattr(MemoryService, "_extract_tag_content", staticmethod(upstream_raw.__func__))
                # also re-assert on the upstream mixin (defensive)
                setattr(UpstreamMemorizeMixin, "_extract_tag_content", staticmethod(upstream_raw.__func__))  # type: ignore
                sys.stderr.write("[memu-bridge] Restored _extract_tag_content from upstream memU (staticmethod)\n")
            else:
                sys.stderr.write("[memu-bridge] Upstream _extract_tag_content not a staticmethod; leaving as-is\n")
        except Exception as _e:
            sys.stderr.write(f"[memu-bridge] Could not restore upstream _extract_tag_content: {_e}\n")

        sys.stderr.write(f"[memu-bridge] Applied memU memorize patches: {patched} methods\n")
    except Exception as e:
        sys.stderr.write(f"[memu-bridge] Failed to apply memU memorize patches: {e}\n")
    finally:
        _MEMU_PATCHED = True


async def _get_service(payload: Dict[str, Any]):
    from memu.app.service import MemoryService  # local install
    _apply_memu_patches_once(MemoryService)

    key = _service_key(payload)
    dig = _payload_digest(payload)

    if key not in _LOCKS:
        _LOCKS[key] = asyncio.Lock()

    async with _LOCKS[key]:
        svc = _SERVICES.get(key)
        if svc is None or _SERVICE_DIGEST.get(key) != dig:
            _massage_llm_profiles(payload)
            _ensure_dirs(payload)
            svc = MemoryService(**_memu_kwargs(payload))
            _SERVICES[key] = svc
            _SERVICE_DIGEST[key] = dig
        return svc

# ---------------------------------------------------------------------------
# Ops
# ---------------------------------------------------------------------------

async def _op_health(payload: Dict[str, Any]) -> Dict[str, Any]:
    svc = await _get_service(payload)
    # Do a cheap touch (no LLM calls).
    try:
        _ = await svc.list_memory_categories(where=None)
    except Exception:
        pass
    
    # Descriptor sanity: tells us whether _extract_tag_content is currently a staticmethod on MemoryService.
    try:
        from memu.app.service import MemoryService as _MS  # type: ignore
        raw = _MS.__dict__.get("_extract_tag_content")
        desc_type = type(raw).__name__ if raw is not None else None
        is_static = isinstance(raw, staticmethod)
    except Exception:
        desc_type = None
        is_static = None

    return {"ok": True, "op": "health", "services": len(_SERVICES), "bridge_instance_id": BRIDGE_INSTANCE_ID, "bridge_started_at": BRIDGE_STARTED_AT, "bridge_build_id": BRIDGE_BUILD_ID, "memu_version": getattr(__import__('memu'), '__version__', None), "service_keys": list(_SERVICES.keys()), "extract_tag_content_descriptor": desc_type, "extract_tag_content_is_staticmethod": is_static}

async def _op_list_categories(payload: Dict[str, Any]) -> Dict[str, Any]:
    svc = await _get_service(payload)
    result = await svc.list_memory_categories(where=None)
    return {"ok": True, "op": "list_categories", "result": result}

async def _op_memorize(payload: Dict[str, Any]) -> Dict[str, Any]:
    base = _ensure_dirs(payload)
    svc = await _get_service(payload)

    conversation = payload.get("conversation")
    normalized = _normalize_conversation(conversation)
    if not normalized:
        return {"ok": False, "op": "memorize", "error": "payload.conversation must be a non-empty list (after normalization)"}

    # Name resource file deterministically-ish to help idempotency when retries happen.
    try:
        dig = hashlib.sha1(json.dumps(normalized, ensure_ascii=False).encode("utf-8")).hexdigest()[:12]
    except Exception:
        dig = uuid.uuid4().hex[:12]

    fname = f"st_conversation_{dig}_{int(time.time())}_{uuid.uuid4().hex}.json"
    convo_path = base / fname
    convo_path.write_text(json.dumps(normalized, ensure_ascii=False), encoding="utf-8")

    result = await svc.memorize(resource_url=str(convo_path), modality="conversation", user=None)
    return {"ok": True, "op": "memorize", "result": result}

async def _run(op: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if op == "health":
        return await _op_health(payload)
    if op == "list_categories":
        return await _op_list_categories(payload)
    if op == "memorize":
        return await _op_memorize(payload)
    return {"ok": False, "error": f"Unknown op: {op}"}

# ---------------------------------------------------------------------------
# Daemon loop (newline-delimited JSON over stdin/stdout)
# ---------------------------------------------------------------------------

async def _daemon_loop() -> int:
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            return 0
        line = line.strip()
        if not line:
            continue

        # Never let a malformed request crash the daemon.
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                _json_out({"ok": False, "error": "Bad request: expected a JSON object"})
                continue

            req_id = req.get("id")
            op = req.get("op")
            payload = req.get("payload") or {}
            if not isinstance(payload, dict):
                payload = {}

            # IMPORTANT: catch BaseException so that unexpected SystemExit/argparse exits
            # (which inherit BaseException, not Exception) do not kill the persistent bridge.
            try:
                res = await _run(op, payload)
                if not isinstance(res, dict):
                    res = {"ok": True, "result": res}
            except BaseException as e:
                try:
                    sys.stderr.write("[memu-bridge] Exception in op %s:\n%s\n" % (op, traceback.format_exc()))
                    sys.stderr.flush()
                except Exception:
                    pass
                res = {"ok": False, "error": f"{type(e).__name__}: {e}", "op": op}

            if req_id is not None:
                res["id"] = req_id
            _json_out(res)

        except BaseException as e:
            # Don't crash the daemon. Surface error and keep going.
            try:
                sys.stderr.write("[memu-bridge] Exception in daemon loop:\n%s\n" % (traceback.format_exc(),))
                sys.stderr.flush()
            except Exception:
                pass
            _json_out({"ok": False, "error": f"{type(e).__name__}: {e}"})
            continue
# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> int:
    sys.stderr.write(f"[memu-bridge] BRIDGE_BUILD_ID={BRIDGE_BUILD_ID}\n")
    ap = argparse.ArgumentParser()
    ap.add_argument("--daemon", action="store_true", help="Run as a persistent stdin/stdout bridge")
    ap.add_argument("--op", choices=["health", "list_categories", "memorize"], default=None)
    ap.add_argument("--payload", default=None)
    args = ap.parse_args()

    try:
        if args.daemon:
            return asyncio.run(_daemon_loop())
        if not args.op:
            raise SystemExit("--op is required unless --daemon is used")

        payload = _load_payload(args.payload)
        res = asyncio.run(_run(args.op, payload))
        _json_out(res)
        return 0 if res.get("ok") else 2
    except BaseException as e:
        # BaseException covers SystemExit, KeyboardInterrupt, etc.
        try:
            sys.stderr.write("[memu-bridge] Exception in main:\n%s\n" % (traceback.format_exc(),))
            sys.stderr.flush()
        except Exception:
            pass
        _json_out({"ok": False, "error": f"{type(e).__name__}: {e}"})
        return 2

if __name__ == "__main__":
    raise SystemExit(main())