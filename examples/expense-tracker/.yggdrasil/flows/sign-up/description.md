# Sign Up Flow

## Business context

New user creates an account to start using the expense tracker. After sign-up, user is logged in and can access the dashboard.

## Trigger

User is on Landing page and clicks "Sign up" or navigates to Register.

## Goal

User account created. Subscription (Free) created automatically. User logged in and redirected to Dashboard.

## Participants

- `api/auth` — validates input, checks email uniqueness, hashes password, inserts User and Subscription (Free) atomically, issues JWT
- `web/auth` — registration form, redirect after success

## Paths

### Happy path

User enters email and password. Validation OK → check email uniqueness → hash password → insert User → insert Subscription (Free) → return JWT → redirect /dashboard.

### Duplicate email

Email already registered. API returns 409. UI shows "This email is already in use".

### Validation failure

Invalid email format or weak password. API returns 400. UI shows validation errors.

## Invariants across all paths

- Every new user gets Free plan. Subscription created atomically with User.
- Password never stored in plain text.
