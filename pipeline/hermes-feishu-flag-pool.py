#!/usr/bin/env python3
r"""
Hermes Feishu Flag Pool
=======================
Manages a registry of flags used by multiple General Agents sharing one
Feishu/Lark channel. Each flag maps to at most one agent at a time so that
`$flag ` replies do not collide.

Usage:
    python hermes-feishu-flag-pool.py lease --agent agent-1
    python hermes-feishu-flag-pool.py lease --random --agent agent-1
    python hermes-feishu-flag-pool.py release alpha
    python hermes-feishu-flag-pool.py list
    python hermes-feishu-flag-pool.py generate

Registry file:
    feishu-flag-registry.json next to this script (override with --registry
    or the HERMES_FLAG_REGISTRY env var).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import string
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_REGISTRY = Path(os.environ.get(
    "HERMES_FLAG_REGISTRY",
    str(Path(__file__).resolve().parent / "feishu-flag-registry.json"),
))

DEFAULT_POOL = [
    # Greek letters (kept for continuity with earlier registrations)
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
    "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho",
    "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
    # Animals — short, unambiguous spelling, easy to type
    "otter", "heron", "koala", "lemur", "marten", "ocelot", "panda", "quokka",
    "tapir", "viper", "walrus", "badger", "beaver", "falcon", "ibis", "jackal",
    "narwhal", "urchin", "yak", "zebra", "wolf", "fox", "bear", "hawk", "owl",
    "raven", "lynx", "stag",
    # Materials and gems
    "amber", "basalt", "cobalt", "copper", "flint", "garnet", "ivory", "jade",
    "onyx", "opal", "pearl", "quartz", "topaz",
    # Trees and plants
    "aspen", "hazel", "juniper", "larch", "rowan", "spruce", "thistle", "oak",
    "pine", "maple", "birch", "cedar", "willow", "elm",
    # Landscape
    "canyon", "dune", "fjord", "glacier", "harbor", "lagoon", "marsh",
    "meadow", "prairie", "tundra", "valley",
    # Sky and space
    "aurora", "cirrus", "comet", "eclipse", "meteor", "monsoon", "nebula",
    "nimbus", "solstice", "zephyr",
    # Objects
    "anchor", "beacon", "compass", "lantern", "prism", "quill", "sundial",
]

# Charset a flag may use: lowercase ASCII letters and digits, bounded length.
FLAG_PATTERN = re.compile(r"^[a-z][a-z0-9]{2,15}$")


def normalize_flag(raw: str) -> Optional[str]:
    """Validate and normalize a caller-supplied flag name; None when invalid."""
    candidate = raw.strip().lower()
    return candidate if FLAG_PATTERN.match(candidate) else None


def load_registry(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"pool": DEFAULT_POOL.copy(), "flags": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        # Union, not setdefault: an existing registry keeps its leased/legacy
        # entries while newly shipped memorable words still become available.
        pool = data.setdefault("pool", [])
        for word in DEFAULT_POOL:
            if word not in pool:
                pool.append(word)
        data.setdefault("flags", {})
        return data
    except Exception as exc:
        print(json.dumps({"error": f"Failed to load registry: {exc}"}), file=sys.stderr)
        sys.exit(1)


def save_registry(path: Path, data: Dict[str, Any]) -> None:
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        print(json.dumps({"error": f"Failed to save registry: {exc}"}), file=sys.stderr)
        sys.exit(1)


def generate_random_flag(length: int = 6) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=length))


def cmd_lease(args: argparse.Namespace) -> int:
    data = load_registry(args.registry)
    agent = args.agent or "anonymous"
    preferred = getattr(args, "flag", None)

    if preferred:
        # A rename request. Honour it even when this agent already holds a flag:
        # release the previous lease so the pool stays accurate, then take the
        # requested name (the registration file is rewritten by the caller).
        candidate = normalize_flag(preferred)
        if candidate is None:
            print(json.dumps({"error": f"invalid flag '{preferred}': use 3-16 lowercase letters/digits, starting with a letter"}), file=sys.stderr)
            return 1
        holder = data["flags"].get(candidate)
        if holder is not None and not holder.get("released") and holder.get("agent") != agent:
            print(json.dumps({"error": f"flag '{candidate}' is already in use by '{holder.get('agent')}'"}), file=sys.stderr)
            return 1
        released_previous = []
        for flag, info in data["flags"].items():
            if flag != candidate and info.get("agent") == agent and not info.get("released"):
                info["released"] = True
                info["released_at"] = time.time()
                released_previous.append(flag)
        data["flags"][candidate] = {"agent": agent, "leased_at": time.time(), "released": False}
        if candidate not in data["pool"]:
            data["pool"].append(candidate)
        save_registry(args.registry, data)
        print(json.dumps({"flag": candidate, "agent": agent, "status": "leased", "released_previous": released_previous}, ensure_ascii=False))
        return 0

    # If this agent already holds a flag, return it.
    for flag, info in data["flags"].items():
        if info.get("agent") == agent and not info.get("released"):
            print(json.dumps({"flag": flag, "agent": agent, "status": "reused"}, ensure_ascii=False))
            return 0

    chosen: Optional[str] = None
    if args.random:
        # Generate a unique random flag not currently in use.
        for _ in range(100):
            candidate = generate_random_flag(args.length)
            if candidate not in data["flags"] or data["flags"][candidate].get("released"):
                chosen = candidate
                break
        if not chosen:
            print(json.dumps({"error": "Could not generate a unique random flag"}), file=sys.stderr)
            return 1
        # Add to pool so it appears in list.
        if chosen not in data["pool"]:
            data["pool"].append(chosen)
    else:
        # Pick a random memorable word still available in the pool.
        available = [f for f in data["pool"]
                     if f not in data["flags"] or data["flags"][f].get("released")]
        if not available:
            print(json.dumps({"error": "No flags available in pool. Use --random to generate one."}), file=sys.stderr)
            return 1
        # Prefer word-shaped, distinctive flags (>=4 letters) over short Greek
        # letters and legacy random strings; fall back when the pool is thin.
        preferred_words = [f for f in available if f.isalpha() and len(f) >= 4]
        words = [f for f in available if f.isalpha()]
        chosen = random.choice(preferred_words or words or available)

    data["flags"][chosen] = {
        "agent": agent,
        "leased_at": time.time(),
        "released": False,
    }
    save_registry(args.registry, data)
    print(json.dumps({"flag": chosen, "agent": agent, "status": "leased"}, ensure_ascii=False))
    return 0


def cmd_release(args: argparse.Namespace) -> int:
    data = load_registry(args.registry)
    flag = args.flag
    if flag not in data["flags"]:
        print(json.dumps({"error": f"Flag '{flag}' is not registered"}), file=sys.stderr)
        return 1
    data["flags"][flag]["released"] = True
    data["flags"][flag]["released_at"] = time.time()
    save_registry(args.registry, data)
    print(json.dumps({"flag": flag, "status": "released"}, ensure_ascii=False))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    data = load_registry(args.registry)
    result = {
        "pool": data.get("pool", []),
        "in_use": {k: v for k, v in data.get("flags", {}).items() if not v.get("released")},
        "released": {k: v for k, v in data.get("flags", {}).items() if v.get("released")},
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_generate(args: argparse.Namespace) -> int:
    flag = generate_random_flag(args.length)
    print(json.dumps({"flag": flag, "source": "random"}, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage Feishu reply flags for multiple agents.")
    parser.add_argument(
        "--registry",
        type=Path,
        default=DEFAULT_REGISTRY,
        help=f"Path to registry JSON (default: {DEFAULT_REGISTRY})",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    lease_parser = subparsers.add_parser("lease", help="Lease an available flag for an agent")
    lease_parser.add_argument("--agent", default="request", help="Agent or request identifier (default: request)")
    lease_parser.add_argument("--flag", default=None, help="Preferred memorable flag name (3-16 lowercase letters/digits, e.g. otter)")
    lease_parser.add_argument("--random", action="store_true", help="Generate a random flag instead of using the word pool")
    lease_parser.add_argument("--length", type=int, default=6, help="Random flag length (default 6)")

    release_parser = subparsers.add_parser("release", help="Release a flag back to the pool")
    release_parser.add_argument("flag", help="Flag to release")

    list_parser = subparsers.add_parser("list", help="List flag pool and current leases")

    gen_parser = subparsers.add_parser("generate", help="Generate a random flag without leasing it")
    gen_parser.add_argument("--length", type=int, default=6, help="Random flag length (default 6)")

    args = parser.parse_args()

    if args.command == "lease":
        return cmd_lease(args)
    if args.command == "release":
        return cmd_release(args)
    if args.command == "list":
        return cmd_list(args)
    if args.command == "generate":
        return cmd_generate(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
