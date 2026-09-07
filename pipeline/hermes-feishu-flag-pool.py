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
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
    "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho",
    "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
    "red", "blue", "green", "yellow", "orange", "purple", "cyan", "magenta",
    "oak", "pine", "maple", "birch", "cedar", "willow", "elm",
    "wolf", "fox", "bear", "hawk", "owl", "raven", "lynx", "stag",
]


def load_registry(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"pool": DEFAULT_POOL.copy(), "flags": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        data.setdefault("pool", DEFAULT_POOL.copy())
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
            if candidate not in data["flags"]:
                chosen = candidate
                break
        if not chosen:
            print(json.dumps({"error": "Could not generate a unique random flag"}), file=sys.stderr)
            return 1
        # Add to pool so it appears in list.
        if chosen not in data["pool"]:
            data["pool"].append(chosen)
    else:
        # Pick first available flag from the predefined pool.
        available = [f for f in data["pool"] if f not in data["flags"]]
        if not available:
            print(json.dumps({"error": "No flags available in pool. Use --random to generate one."}), file=sys.stderr)
            return 1
        chosen = available[0]

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
    lease_parser.add_argument("--random", action="store_true", help="Generate a random flag instead of using the pool")
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
