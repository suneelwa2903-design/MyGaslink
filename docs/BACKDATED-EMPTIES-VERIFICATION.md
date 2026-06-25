# Backdated Empties + UI cleanup — Verification

_Run: 2026-06-25T08:21:46.229Z against http://localhost:5000, dist-002 (Sharma Gas Distributors)._

**Headline:** 15 PASS · 0 PARTIAL · 0 FAIL · 0 SKIP (of 15)

## Scenarios

### A1: Create — emptiesCollected persists per item

- **Status:** PASS
- **Expected:** 19KG empties=2, 47.5KG empties=0
- **Actual:** 19 KG: qty=2, delivered=2, empties=2 | 47.5 KG: qty=1, delivered=1, empties=0

### A2: Create without field → default 0 (not NULL)

- **Status:** PASS
- **Expected:** emptiesCollected=0
- **Actual:** emptiesCollected=0

### A3: Create with explicit emptiesCollected=0

- **Status:** PASS
- **Expected:** emptiesCollected=0
- **Actual:** emptiesCollected=0

### A4: Negative emptiesCollected rejected with 400

- **Status:** PASS
- **Expected:** HTTP 400
- **Actual:** HTTP 400; body={"success":false,"data":null,"error":"Validation failed","code":"VALIDATION_ERROR","details":{"items":["Number must be greater than or equal to 0"]}}

### B1: Apply — empties event fires only where empties > 0

- **Status:** PASS
- **Expected:** manual_adjustment(19K, -2) + manual_adjustment(47.5K, -1) + reconciliation_empties_return(19K, +2); NO empties event for 47.5K; all today
- **Actual:** apply HTTP=200; events.count=3; 19KG manual_adjustment fc=-2; 47.5KG manual_adjustment fc=-1; 19KG reconciliation_empties_return ec=2; 47.5KG reconciliation_empties_return: absent (correct); all events dated today=true

### B2: All-empties-0 order writes ONLY manual_adjustment

- **Status:** PASS
- **Expected:** exactly 1 manual_adjustment event
- **Actual:** event types=[manual_adjustment]

### B3: Pending API includes emptiesCollected on per-item rows

- **Status:** PASS
- **Expected:** 19KG emptiesCollected=2
- **Actual:** pending API HTTP=200; row found in pending=true; 19KG empties from source=2

### B4: Confirmation modal data includes Credit lines

- **Status:** PASS
- **Expected:** Deduct 3× 19 KG fulls | Credit 2× 19 KG empties | Deduct 1× 5 KG fulls | Credit 1× 5 KG empties
- **Actual:** lines=["Deduct 3× 19 KG fulls","Credit 2× 19 KG empties","Deduct 1× 5 KG fulls","Credit 1× 5 KG empties"]

### C1: Legacy payload (no emptiesCollected) still works

- **Status:** PASS
- **Expected:** 201 + emptiesCollected=0
- **Actual:** emptiesCollected=0

### C2: Normal order create unaffected (extra empties field ignored at create)

- **Status:** PASS
- **Expected:** 201; emptiesCollected null or 0 (filled at confirm-delivery, not create)
- **Actual:** HTTP 201; emptiesCollected on the persisted item: (null)

### C3: Godown pickup empties logic unchanged

- **Status:** PASS
- **Expected:** godown synthetic dispatch + reconciliation_empties_return events present
- **Actual:** confirm HTTP=200; events=[dispatch,reconciliation_empties_return,delivery,collection]; godown synthetic dispatch=true; godown synthetic return=true

### C4: Double-apply still rejected with 409

- **Status:** PASS
- **Expected:** HTTP 409
- **Actual:** HTTP 409; err="Inventory already adjusted for this order"

### C5: Non-backdated order still rejected with 400

- **Status:** PASS
- **Expected:** HTTP 400
- **Actual:** HTTP 400

### D1: E2E — fulls −3, empties +2 events written today

- **Status:** PASS
- **Expected:** manual_adjustment fc=-3 AND reconciliation_empties_return ec=+2, both dated today
- **Actual:** apply HTTP=200; manual_adjustment(fc=-3, eventDate=2026-06-25); reconciliation_empties_return(ec=2, eventDate=2026-06-25)

### D2: Pending Items column renders "(N empty)" when > 0

- **Status:** PASS
- **Expected:** 3× 19 KG (2 empty)
- **Actual:** pending row found=true; itemSummary="3× 19 KG (2 empty)"

## Summary

| Scenario | Status | Notes |
|---|---|---|
| A1 | PASS |  |
| A2 | PASS |  |
| A3 | PASS |  |
| A4 | PASS |  |
| B1 | PASS |  |
| B2 | PASS |  |
| B3 | PASS |  |
| B4 | PASS |  |
| C1 | PASS |  |
| C2 | PASS |  |
| C3 | PASS |  |
| C4 | PASS |  |
| C5 | PASS |  |
| D1 | PASS |  |
| D2 | PASS |  |

## ✅ ALL CLEAR — Backdated empties end-to-end.
