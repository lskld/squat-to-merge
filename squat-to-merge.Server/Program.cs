using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Octokit;
using SquatToMerge.Server.Services;

var builder = WebApplication.CreateBuilder(args);

// Add service defaults & Aspire client integrations.
builder.AddServiceDefaults();

builder.Services.AddProblemDetails();
builder.Services.AddOpenApi();

// Authentication via cookies (GitHub OAuth handled manually)
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        options.ExpireTimeSpan = TimeSpan.FromDays(7);
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = 401;
            return Task.CompletedTask;
        };
    });
builder.Services.AddAuthorization();

// Application services
builder.Services.AddSingleton<RoomManager>();
builder.Services.AddSingleton<LiveKitService>();
builder.Services.AddSingleton<GitHubService>();
builder.Services.AddHttpClient();

var app = builder.Build();

static string GetPublicBaseUrl(HttpContext ctx, IConfiguration config)
{
    var configured = config["App:BaseUrl"];
    if (!string.IsNullOrWhiteSpace(configured))
    {
        return configured.TrimEnd('/');
    }

    return $"{ctx.Request.Scheme}://{ctx.Request.Host}";
}

app.UseExceptionHandler();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseAuthentication();
app.UseAuthorization();

var api = app.MapGroup("/api");

// ──────────────────────────────────────────────
//  Auth endpoints (GitHub App user auth)
// ──────────────────────────────────────────────
var auth = api.MapGroup("/auth");

auth.MapGet("/login", (HttpContext ctx, IConfiguration config) =>
{
    var clientId = config["GitHub:ClientId"]
        ?? throw new InvalidOperationException("GitHub:ClientId is not configured.");

    var callbackUrl = $"{GetPublicBaseUrl(ctx, config)}/api/auth/callback";
    var state = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));

    ctx.Response.Cookies.Append("oauth_state", state, new CookieOptions
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Lax,
        Secure = ctx.Request.IsHttps,
        MaxAge = TimeSpan.FromMinutes(10)
    });

    var url =
        $"https://github.com/login/oauth/authorize?client_id={clientId}" +
        $"&redirect_uri={Uri.EscapeDataString(callbackUrl)}" +
        $"&state={state}";

    return Results.Redirect(url);
});

auth.MapGet("/install", (IConfiguration config) =>
{
    var appSlug = config["GitHub:AppSlug"]
        ?? throw new InvalidOperationException("GitHub:AppSlug is not configured.");

    return Results.Redirect($"https://github.com/apps/{appSlug}/installations/new");
});

auth.MapGet("/callback", async (
    HttpContext ctx,
    string code,
    string state,
    IConfiguration config,
    IHttpClientFactory httpFactory,
    GitHubService github) =>
{
    // Verify state
    var savedState = ctx.Request.Cookies["oauth_state"];
    if (string.IsNullOrEmpty(savedState) || savedState != state)
    {
        return Results.BadRequest("Invalid OAuth state.");
    }
    ctx.Response.Cookies.Delete("oauth_state");

    // Exchange code for access token
    var httpClient = httpFactory.CreateClient();
    var tokenRequest = new HttpRequestMessage(HttpMethod.Post,
        "https://github.com/login/oauth/access_token");
    tokenRequest.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    tokenRequest.Content = JsonContent.Create(new
    {
        client_id = config["GitHub:ClientId"],
        client_secret = config["GitHub:ClientSecret"],
        code
    });

    var tokenResponse = await httpClient.SendAsync(tokenRequest);
    var tokenData = await tokenResponse.Content.ReadFromJsonAsync<JsonElement>();

    if (!tokenData.TryGetProperty("access_token", out var accessTokenProp))
    {
        return Results.BadRequest("GitHub did not return an access token.");
    }
    var accessToken = accessTokenProp.GetString()!;

    var githubUser = await github.GetAuthenticatedUserAsync(accessToken);

    // Create claims and sign in
    var claims = new List<Claim>
    {
        new(ClaimTypes.Name, githubUser.Login),
        new("urn:github:user_access_token", accessToken),
        new("urn:github:avatar", githubUser.AvatarUrl)
    };

    var identity = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
    await ctx.SignInAsync(
        CookieAuthenticationDefaults.AuthenticationScheme,
        new ClaimsPrincipal(identity));

    return Results.Redirect("/dashboard");
});

auth.MapGet("/me", (ClaimsPrincipal user) =>
{
    if (user.Identity?.IsAuthenticated != true)
    {
        return Results.Json(new { isAuthenticated = false });
    }
    return Results.Json(new
    {
        isAuthenticated = true,
        login = user.Identity.Name,
        avatarUrl = user.FindFirstValue("urn:github:avatar")
    });
});

auth.MapPost("/logout", async (HttpContext ctx) =>
{
    await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.Ok();
});

// ──────────────────────────────────────────────
//  Repository endpoints
// ──────────────────────────────────────────────
var repos = api.MapGroup("/repos").RequireAuthorization();

repos.MapGet("/", async (ClaimsPrincipal user, GitHubService github) =>
{
    var token = user.FindFirstValue("urn:github:user_access_token")!;
    var repositories = await github.GetRepositoriesForUserAsync(token);
    return Results.Json(repositories.Select(r => new
    {
        r.Id,
        r.Name,
        r.FullName,
        owner = r.Owner,
        isPrivate = r.IsPrivate,
        r.Description
    }));
});

repos.MapPost("/{owner}/{repo}/watch", async (
    string owner,
    string repo,
    ClaimsPrincipal user,
    GitHubService github,
    RoomManager roomManager,
    IConfiguration config,
    HttpContext ctx) =>
{
    var webhookSecret = config["GitHub:WebhookSecret"] ?? "squat-to-merge-default-secret";

    // Determine the public base URL for the webhook callback
    var baseUrl = GetPublicBaseUrl(ctx, config);
    var webhookUrl = $"{baseUrl}/api/webhooks/github";

    try
    {
        var installationId = await github.GetInstallationIdForRepoAsync(owner, repo);
        var webhookId = await github.CreateWebhookAsync(installationId, owner, repo, webhookUrl, webhookSecret);
        roomManager.AddWatch(owner, repo, installationId, webhookId);
        return Results.Ok(new { message = "Repository is now watched for PRs.", webhookId });
    }
    catch (AuthorizationException)
    {
        return Results.Problem(
            statusCode: 403,
            detail: "GitHub denied webhook creation. Ensure this OAuth app has scope 'admin:repo_hook' and your account has admin access to the repository. Then logout and sign in again.");
    }
    catch (ApiException ex) when (ex.StatusCode == HttpStatusCode.Forbidden)
    {
        return Results.Problem(
            statusCode: 403,
            detail: "GitHub denied webhook creation (403). Ensure this OAuth app has scope 'admin:repo_hook' and your account has admin access to the repository. Then logout and sign in again.");
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

repos.MapDelete("/{owner}/{repo}/watch", async (
    string owner,
    string repo,
    GitHubService github,
    RoomManager roomManager) =>
{
    var watch = roomManager.GetWatch(owner, repo);
    if (watch == null)
    {
        return Results.NotFound();
    }

    try
    {
        await github.DeleteWebhookAsync(watch.InstallationId, owner, repo, watch.WebhookId);
    }
    catch { /* Webhook may already be deleted on GitHub */ }

    roomManager.RemoveWatch(owner, repo);
    return Results.Ok(new { message = "Stopped watching repository." });
});

repos.MapGet("/watched", (RoomManager roomManager) =>
{
    return Results.Json(roomManager.GetAllWatches().Select(w => new
    {
        w.Owner,
        w.Repo
    }));
});

// ──────────────────────────────────────────────
//  GitHub webhook handler
// ──────────────────────────────────────────────
api.MapPost("/webhooks/github", async (
    HttpContext ctx,
    RoomManager roomManager,
    GitHubService github,
    LiveKitService livekit,
    IConfiguration config,
    ILogger<Program> logger) =>
{
    // Read body
    ctx.Request.EnableBuffering();
    var body = await new StreamReader(ctx.Request.Body).ReadToEndAsync();
    ctx.Request.Body.Position = 0;

    // Verify signature
    var signature = ctx.Request.Headers["X-Hub-Signature-256"].FirstOrDefault();
    var webhookSecret = config["GitHub:WebhookSecret"] ?? "squat-to-merge-default-secret";
    if (!VerifyGitHubSignature(body, signature, webhookSecret))
    {
        logger.LogWarning("Invalid GitHub webhook signature");
        return Results.Unauthorized();
    }

    var eventType = ctx.Request.Headers["X-GitHub-Event"].FirstOrDefault();
    if (eventType != "pull_request")
    {
        return Results.Ok();
    }

    var payload = JsonSerializer.Deserialize<JsonElement>(body);
    var action = payload.GetProperty("action").GetString();
    if (action is not ("opened" or "reopened"))
    {
        return Results.Ok();
    }

    var pr = payload.GetProperty("pull_request");
    var prNumber = pr.GetProperty("number").GetInt32();
    var prAuthor = pr.GetProperty("user").GetProperty("login").GetString()!;
    var repoFullName = payload.GetProperty("repository").GetProperty("full_name").GetString()!;
    var parts = repoFullName.Split('/');
    var owner = parts[0];
    var repo = parts[1];

    logger.LogInformation("PR #{PrNumber} {Action} by {Author} in {Repo}",
        prNumber, action, prAuthor, repoFullName);

    // Create room
    var room = roomManager.CreateRoom(owner, repo, prNumber, prAuthor);

    // Post comment on PR with room link
    var watch = roomManager.GetWatch(owner, repo);
    if (watch != null)
    {
        var baseUrl = GetPublicBaseUrl(ctx, config);
        var roomUrl = $"{baseUrl}/room/{room.RoomId}";
        var comment =
            $"""
            ## 🏋️ Squat-to-Merge Challenge!
            
            Hey @{prAuthor}! Before this PR can be merged, you need to complete **10 squats** on camera!
            
            **[👉 Join the Squat Room]({roomUrl})**
            
            Others can watch and cheer you on using the same link. Let's go! 💪
            """;

        try
        {
            await github.PostPrCommentAsync(watch.InstallationId, owner, repo, prNumber, comment);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to post PR comment for {Repo}#{PrNumber}", repoFullName, prNumber);
        }
    }

    return Results.Ok();
});

// ──────────────────────────────────────────────
//  Room endpoints
// ──────────────────────────────────────────────
var rooms = api.MapGroup("/rooms");

rooms.MapGet("/", (RoomManager roomManager) =>
{
    return Results.Json(roomManager.GetAllRooms().Select(r => new
    {
        r.RoomId,
        r.RepoOwner,
        r.RepoName,
        r.PrNumber,
        r.PrAuthor,
        r.SquatCount,
        r.IsMerged
    }));
});

rooms.MapGet("/{roomId}", (string roomId, RoomManager roomManager) =>
{
    var room = roomManager.GetRoom(roomId);
    if (room == null)
    {
        return Results.NotFound();
    }
    return Results.Json(new
    {
        room.RoomId,
        room.RepoOwner,
        room.RepoName,
        room.PrNumber,
        room.PrAuthor,
        room.SquatCount,
        room.IsMerged,
        squatGoal = 10
    });
});

rooms.MapPost("/{roomId}/token", (string roomId, HttpContext ctx,
    RoomManager roomManager, LiveKitService livekit) =>
{
    var room = roomManager.GetRoom(roomId);
    if (room == null)
    {
        return Results.NotFound();
    }

    var login = ctx.User.Identity?.IsAuthenticated == true
        ? ctx.User.Identity.Name!
        : $"viewer-{Guid.NewGuid().ToString("N")[..8]}";

    var isSquatter = ctx.User.Identity?.Name == room.PrAuthor;
    var token = livekit.GenerateToken(roomId, login, canPublish: isSquatter);

    return Results.Json(new
    {
        token,
        url = livekit.GetUrl(),
        isSquatter,
        identity = login
    });
});

rooms.MapPost("/{roomId}/complete", async (
    string roomId,
    ClaimsPrincipal user,
    RoomManager roomManager,
    GitHubService github,
    ILogger<Program> logger) =>
{
    var room = roomManager.GetRoom(roomId);
    if (room == null)
    {
        return Results.NotFound();
    }

    if (room.IsMerged)
    {
        return Results.Ok(new { message = "Already merged." });
    }

    var currentUser = user.Identity?.Name;
    if (currentUser != room.PrAuthor)
    {
        return Results.Forbid();
    }

    var watch = roomManager.GetWatch(room.RepoOwner, room.RepoName);
    if (watch == null)
    {
        return Results.Problem("No watch configuration found for this repository.");
    }

    try
    {
        await github.MergePrAsync(watch.InstallationId, room.RepoOwner, room.RepoName, room.PrNumber);
        room.IsMerged = true;
        room.SquatCount = 10;

        logger.LogInformation("PR #{PrNumber} in {Owner}/{Repo} merged via squat-to-merge!",
            room.PrNumber, room.RepoOwner, room.RepoName);

        return Results.Ok(new { message = "PR merged successfully! 💪🏋️" });
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Failed to merge PR #{PrNumber} in {Owner}/{Repo}",
            room.PrNumber, room.RepoOwner, room.RepoName);
        return Results.Problem($"Failed to merge PR: {ex.Message}");
    }
}).RequireAuthorization();

// ──────────────────────────────────────────────

app.MapDefaultEndpoints();
app.UseFileServer();

// SPA fallback — serve index.html for client-side routes
app.MapFallbackToFile("index.html");

app.Run();

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

static bool VerifyGitHubSignature(string payload, string? signatureHeader, string secret)
{
    if (string.IsNullOrEmpty(signatureHeader) || !signatureHeader.StartsWith("sha256="))
        return false;

    var expected = signatureHeader["sha256=".Length..];
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
    var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(payload));
    var actual = Convert.ToHexString(hash).ToLowerInvariant();

    return CryptographicOperations.FixedTimeEquals(
        Encoding.UTF8.GetBytes(actual),
        Encoding.UTF8.GetBytes(expected));
}
