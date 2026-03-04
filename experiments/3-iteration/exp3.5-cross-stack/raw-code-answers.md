# Exp 3.5: Raw Code Answers (Agent C — Django Auth)

## Q1: Impact Analysis — Changing `BaseBackend.authenticate()` Signature

If you change the `authenticate()` method signature in `BaseBackend` (e.g., adding a required parameter or changing the return type), here is every point of breakage:

### Direct Callers of `backend.authenticate()`

**1. `auth.authenticate()` in `__init__.py`** — Central dispatch function. Iterates over all backends via `_get_compatible_backends()` and calls `backend.authenticate(request, **credentials)`. Critically, there is a **signature-based compatibility filter**:

```python
def _get_compatible_backends(request, **credentials):
    for backend, backend_path in _get_backends(return_tuples=True):
        backend_signature = signature(backend.authenticate)
        try:
            backend_signature.bind(request, **credentials)
        except TypeError:
            continue
        yield backend, backend_path
```

Adding a required parameter → `bind()` raises `TypeError` → backend **silently excluded**. This is worse than a crash — authentication fails silently.

**2. `auth.aauthenticate()`** — Async variant uses same filter but calls `aauthenticate`. Since `BaseBackend.aauthenticate` delegates to `self.authenticate` via `sync_to_async`, changing `authenticate`'s signature breaks the async path indirectly.

**3. `RemoteUserMiddleware.process_request()`** — Passes `remote_user=username` as credential. Flows through `_get_compatible_backends()` filter.

**4. `RemoteUserMiddleware.aprocess_request()`** — Async variant, same impact.

### Subclass Overrides That Must Stay Compatible

- `ModelBackend.authenticate()` — `(self, request, username=None, password=None, **kwargs)`
- `RemoteUserBackend.authenticate()` — `(self, request, remote_user)`
- Both have `aauthenticate()` async variants

### Return Type Change Impact

If return type changes from User/None to something else:
- `auth.authenticate()` checks `if user is None: continue` then sets `user.backend = backend_path`
- `auth.login()` calls `user.get_session_auth_hash()`, `user._meta.pk.value_to_string(user)` — breaks for non-User
- `RemoteUserMiddleware` checks `if user:` then sets `request.user = user`

### Summary

The `_get_compatible_backends` signature introspection acts as a **circuit breaker** — adding a required parameter causes silent authentication failure (backend skipped), not a crash. A return type change propagates through `auth.login()` into session storage, causing runtime errors. The code reveals WHAT (the signature introspection mechanism) and partially WHY (comment: "This backend doesn't accept these credentials as arguments").

---

## Q2: Flow Tracing — HTTP Request to `@permission_required` Response

### Stage 1: AuthenticationMiddleware sets up `request.user` (middleware.py)

```python
request.user = SimpleLazyObject(lambda: get_user(request))
request.auser = partial(auser, request)
```

`request.user` is a `SimpleLazyObject` — user NOT fetched yet. Deferred until first attribute access.

### Stage 2: Lazy user resolution (when first accessed)

`get_user(request)` → `auth.get_user(request)`:
1. Reads `SESSION_KEY` and `BACKEND_SESSION_KEY` from `request.session`
2. Verifies backend path is in `settings.AUTHENTICATION_BACKENDS`
3. Calls `backend.get_user(user_id)` — for ModelBackend: `UserModel._default_manager.get(pk=user_id)`
4. Verifies session auth hash (password-change protection)
5. Returns User or `AnonymousUser()`

### Stage 3: LoginRequiredMiddleware (if installed)

`process_view` checks:
- `getattr(view_func, "login_required", True)` — defaults to True
- `request.user.is_authenticated` — triggers lazy evaluation if not yet resolved
- If not authenticated → redirect to login

### Stage 4: `@permission_required('myapp.view_item')` executes

```python
permission_required(perm) → user_passes_test(check_perms) → _view_wrapper
```

`_view_wrapper` accesses `request.user` (triggers lazy evaluation if not yet done), calls `check_perms(user)` → `user.has_perms(perms)`.

### Stage 5: Permission checking through backend chain

`user.has_perms(perms)` → `has_perm(perm)`:
1. Active superusers bypass all checks
2. Otherwise, `_user_has_perm` iterates ALL backends
3. `ModelBackend.has_perm` → `get_all_permissions` → caches in `_perm_cache`
4. Queries `user_permissions.all()` + `Permission.objects.filter(group__in=...)`

### Stage 6: Result

- Permission granted → original view returns response
- Permission denied + `raise_exception=False` → redirect to login URL
- Permission denied + `raise_exception=True` → 403 PermissionDenied

### Lazy Evaluation Mechanism

`SimpleLazyObject` wraps a callable, defers execution until first attribute access. `_cached_user` adds second caching layer. If view never accesses `request.user`, no database query occurs.

---

## Q3: Three Parallel Access Restriction Mechanisms

### What Each Does

**Decorators** (`@login_required`, `@permission_required`):
- Function wrappers on individual views
- Work with sync and async views (detects via `iscoroutinefunction`)
- Stamp `login_url`/`redirect_field_name` attributes (consumed by middleware)

**Class-based view mixins** (`LoginRequiredMixin`, `PermissionRequiredMixin`):
- Override `dispatch()` to intercept class-based views
- `AccessMixin.handle_no_permission()` distinguishes authenticated-but-unauthorized (403) from not-authenticated (redirect) — smarter than decorator default

**LoginRequiredMiddleware**:
- Global default-deny: ALL views require login by default
- Views opt out with `@login_not_required` (sets `view_func.login_required = False`)
- Reads `login_url`/`redirect_field_name` from view function attributes

### Trade-offs

| Dimension | Decorators | Mixins | Middleware |
|-----------|-----------|--------|-----------|
| Scope | Per-view (opt-in) | Per-class (opt-in) | Global (opt-out) |
| View type | Function-based (+CBV via method_decorator) | Class-based only | All |
| Permission check | Yes (@permission_required) | Yes (PermissionRequiredMixin) | Login only, no permissions |
| Error handling | Always redirect (unless raise_exception) | Smart: redirect if anon, 403 if authed | Redirect |
| Composability | Stacking | MRO inheritance, class attributes | Per-setting |

### Why All Three Exist

The code does NOT explain WHY explicitly. Observable evidence:

1. **Django's dual view system** — Function-based views need decorators, class-based views need mixins. No single Python pattern elegantly works for both.
2. **Different abstraction levels** — Middleware enforces site-wide policy; decorators/mixins enforce per-view rules. They compose (middleware auth check + decorator permission check).
3. **Designed to interoperate** — Evidence: decorators stamp attributes consumed by middleware; `@login_not_required` opts out of middleware enforcement.
4. **The fundamental reason is architectural necessity, not redundancy.**

What the code CANNOT tell: historical sequence, alternatives considered, stated preference.
