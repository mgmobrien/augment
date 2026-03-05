# Augment proxy endpoint — implementation plan

`POST /api/augment/complete`

Validates Relay auth, checks active subscription, enforces $1/day per-user cap, proxies to Anthropic.

## New collection: `augment_usage`

Fields:
- `user` — relation to users (required)
- `date` — text `YYYY-MM-DD` (required)
- `input_tokens` — number (default 0)
- `output_tokens` — number (default 0)
- `cost_usd` — number (default 0.0)

Add via PocketBase admin UI or migration.

## Environment variable

```
ANTHROPIC_API_KEY=sk-ant-...
```

Set via `fly secrets set ANTHROPIC_API_KEY=...` on staging and prod.

## Endpoint code (add in main.go inside app.OnServe())

```go
e.Router.POST("/api/augment/complete", func(e *core.RequestEvent) error {
    user := e.Auth
    if user == nil {
        return apis.NewUnauthorizedError("Not authenticated", nil)
    }

    // 1. Check active Relay subscription
    _, err := app.FindFirstRecordByFilter(
        "subscriptions",
        "user={:user} && active=true",
        dbx.Params{"user": user.Id},
    )
    if err != nil {
        return apis.NewForbiddenError("No active subscription", nil)
    }

    // 2. Check daily spend cap ($1.00 USD)
    today := time.Now().UTC().Format("2006-01-02")
    usageRecord, _ := app.FindFirstRecordByFilter(
        "augment_usage",
        "user={:user} && date={:date}",
        dbx.Params{"user": user.Id, "date": today},
    )
    if usageRecord != nil && usageRecord.GetFloat("cost_usd") >= 1.00 {
        return e.JSON(429, map[string]string{
            "message": "Daily limit reached — resets at midnight UTC",
        })
    }

    // 3. Parse request body
    var req struct {
        Model     string                   `json:"model"`
        System    string                   `json:"system"`
        Messages  []map[string]interface{} `json:"messages"`
        MaxTokens int                      `json:"max_tokens"`
    }
    if err := e.BindBody(&req); err != nil {
        return apis.NewBadRequestError("Invalid request body", err)
    }
    if req.MaxTokens == 0 {
        req.MaxTokens = 1024
    }

    // 4. Forward to Anthropic
    anthropicKey := os.Getenv("ANTHROPIC_API_KEY")
    if anthropicKey == "" {
        return apis.NewInternalServerError("Proxy not configured", nil)
    }

    payload, _ := json.Marshal(map[string]interface{}{
        "model":      req.Model,
        "system":     req.System,
        "messages":   req.Messages,
        "max_tokens": req.MaxTokens,
    })

    anthropicReq, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(payload))
    anthropicReq.Header.Set("x-api-key", anthropicKey)
    anthropicReq.Header.Set("anthropic-version", "2023-06-01")
    anthropicReq.Header.Set("content-type", "application/json")

    httpClient := &http.Client{Timeout: 120 * time.Second}
    resp, err := httpClient.Do(anthropicReq)
    if err != nil {
        return apis.NewInternalServerError("Anthropic request failed", err)
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)

    if resp.StatusCode != 200 {
        return e.JSON(resp.StatusCode, json.RawMessage(body))
    }

    // 5. Parse usage and record cost
    var anthropicResp struct {
        Content []struct {
            Type string `json:"type"`
            Text string `json:"text"`
        } `json:"content"`
        Usage struct {
            InputTokens  int `json:"input_tokens"`
            OutputTokens int `json:"output_tokens"`
        } `json:"usage"`
    }
    if err := json.Unmarshal(body, &anthropicResp); err == nil {
        // Conservative: use Sonnet 4.6 pricing as upper bound ($3/$15 per MTok).
        // Actual cost lower if Haiku is used.
        costUsd := float64(anthropicResp.Usage.InputTokens)/1_000_000*3.0 +
            float64(anthropicResp.Usage.OutputTokens)/1_000_000*15.0

        if usageRecord == nil {
            collection, _ := app.FindCollectionByNameOrId("augment_usage")
            usageRecord = core.NewRecord(collection)
            usageRecord.Set("user", user.Id)
            usageRecord.Set("date", today)
            usageRecord.Set("input_tokens", anthropicResp.Usage.InputTokens)
            usageRecord.Set("output_tokens", anthropicResp.Usage.OutputTokens)
            usageRecord.Set("cost_usd", costUsd)
        } else {
            usageRecord.Set("input_tokens", usageRecord.GetInt("input_tokens")+anthropicResp.Usage.InputTokens)
            usageRecord.Set("output_tokens", usageRecord.GetInt("output_tokens")+anthropicResp.Usage.OutputTokens)
            usageRecord.Set("cost_usd", usageRecord.GetFloat("cost_usd")+costUsd)
        }
        _ = app.Save(usageRecord)
    }

    // 6. Return Anthropic response verbatim
    return e.JSON(200, json.RawMessage(body))

}).Bind(apis.RequireAuth("users"))
```

## Required imports to add in main.go

```
"bytes"
"encoding/json"
"io"
"net/http"
"os"
"time"
```

## Token pricing note

Cap calculation uses Sonnet 4.6 pricing ($3/$15 per MTok input/output) as a conservative
upper bound. Haiku 4.5 is $0.80/$4. If Augment defaults to Haiku, the effective budget
per $1/day cap is ~5× higher in token terms. Adjust pricing constants per model if needed.

## Deployment steps

1. Create `augment_usage` collection (PocketBase admin UI or migration)
2. `fly secrets set ANTHROPIC_API_KEY=sk-ant-...` (staging first, then prod)
3. Add endpoint code to main.go, add imports
4. Deploy: `make deploy` or `fly deploy`

## Race condition note

The cap check is read-before-write. Two simultaneous requests from the same user near
the $1.00 boundary can both pass. For this cap level this is acceptable — worst case is
one extra request slips through. Add a Redis atomic counter or advisory lock if tighter
enforcement is needed later.
