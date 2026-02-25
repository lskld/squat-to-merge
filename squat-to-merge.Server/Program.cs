using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);

// Add service defaults & Aspire client integrations.
builder.AddServiceDefaults();

// Add services to the container.
builder.Services.AddProblemDetails();

// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

var app = builder.Build();

// Configure the HTTP request pipeline.
app.UseExceptionHandler();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}


string[] summaries = ["Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching"];

var api = app.MapGroup("/api");
api.MapGet("weatherforecast", () =>
{
    var forecast = Enumerable.Range(1, 5).Select(index =>
        new WeatherForecast
        (
            DateOnly.FromDateTime(DateTime.Now.AddDays(index)),
            Random.Shared.Next(-20, 55),
            summaries[Random.Shared.Next(summaries.Length)]
        ))
        .ToArray();
    return forecast;
})
.WithName("GetWeatherForecast");

api.MapPost("livekit/token", (LiveKitTokenRequest request, IConfiguration configuration) =>
{
    if (string.IsNullOrWhiteSpace(request.RoomName) || string.IsNullOrWhiteSpace(request.ParticipantName))
    {
        return Results.BadRequest(new { error = "Room name and participant name are required." });
    }

    var liveKitUrl = configuration["LiveKit:Url"];
    var apiKey = configuration["LiveKit:ApiKey"];
    var apiSecret = configuration["LiveKit:ApiSecret"];

    if (string.IsNullOrWhiteSpace(liveKitUrl) || string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(apiSecret))
    {
        return Results.Problem(
            title: "LiveKit is not configured",
            detail: "Set LiveKit:Url, LiveKit:ApiKey, and LiveKit:ApiSecret in configuration.",
            statusCode: StatusCodes.Status500InternalServerError);
    }

    var identity = request.ParticipantName.Trim();
    var roomName = request.RoomName.Trim();

    if (request.CanPublish && !RoomSquatterRegistry.IsOwner(roomName, identity))
    {
        return Results.BadRequest(new
        {
            error = "Only the current room squatter can publish. Claim squatter role first."
        });
    }

    var token = LiveKitTokenFactory.Create(apiKey, apiSecret, identity, roomName, request.CanPublish);

    return Results.Ok(new
    {
        token,
        url = liveKitUrl,
        roomName,
        participantName = identity,
    });
})
.WithName("CreateLiveKitToken");

api.MapPost("livekit/claim-squatter", (LiveKitRoleRequest request) =>
{
    if (string.IsNullOrWhiteSpace(request.RoomName) || string.IsNullOrWhiteSpace(request.ParticipantName))
    {
        return Results.BadRequest(new { error = "Room name and participant name are required." });
    }

    var roomName = request.RoomName.Trim();
    var participantName = request.ParticipantName.Trim();
    var claimResult = RoomSquatterRegistry.TryClaim(roomName, participantName);

    if (!claimResult.Success)
    {
        return Results.Conflict(new { error = $"{claimResult.CurrentSquatter} is already the squatter in this room." });
    }

    return Results.Ok(new { roomName, squatter = participantName });
})
.WithName("ClaimSquatter");

api.MapPost("livekit/release-squatter", (LiveKitRoleRequest request) =>
{
    if (string.IsNullOrWhiteSpace(request.RoomName) || string.IsNullOrWhiteSpace(request.ParticipantName))
    {
        return Results.BadRequest(new { error = "Room name and participant name are required." });
    }

    var roomName = request.RoomName.Trim();
    var participantName = request.ParticipantName.Trim();

    RoomSquatterRegistry.ReleaseIfOwner(roomName, participantName);
    return Results.Ok(new { roomName, released = participantName });
})
.WithName("ReleaseSquatter");

app.MapDefaultEndpoints();

app.UseFileServer();

app.Run();

record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary)
{
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}

record LiveKitTokenRequest(string RoomName, string ParticipantName, bool CanPublish);
record LiveKitRoleRequest(string RoomName, string ParticipantName);

static class RoomSquatterRegistry
{
    private static readonly Dictionary<string, string> RoomToSquatter = new(StringComparer.OrdinalIgnoreCase);
    private static readonly object SyncLock = new();

    public static (bool Success, string? CurrentSquatter) TryClaim(string roomName, string participantName)
    {
        lock (SyncLock)
        {
            if (RoomToSquatter.TryGetValue(roomName, out var existingSquatter) && !string.Equals(existingSquatter, participantName, StringComparison.Ordinal))
            {
                return (false, existingSquatter);
            }

            RoomToSquatter[roomName] = participantName;
            return (true, participantName);
        }
    }

    public static bool IsOwner(string roomName, string participantName)
    {
        lock (SyncLock)
        {
            return RoomToSquatter.TryGetValue(roomName, out var existingSquatter)
                && string.Equals(existingSquatter, participantName, StringComparison.Ordinal);
        }
    }

    public static void ReleaseIfOwner(string roomName, string participantName)
    {
        lock (SyncLock)
        {
            if (RoomToSquatter.TryGetValue(roomName, out var existingSquatter)
                && string.Equals(existingSquatter, participantName, StringComparison.Ordinal))
            {
                RoomToSquatter.Remove(roomName);
            }
        }
    }
}

static class LiveKitTokenFactory
{
    public static string Create(string apiKey, string apiSecret, string identity, string roomName, bool canPublish)
    {
        var now = DateTimeOffset.UtcNow;

        var headerJson = JsonSerializer.Serialize(new { alg = "HS256", typ = "JWT" });

        var payloadJson = JsonSerializer.Serialize(new
        {
            iss = apiKey,
            sub = identity,
            nbf = now.ToUnixTimeSeconds(),
            exp = now.AddHours(6).ToUnixTimeSeconds(),
            name = identity,
            video = new
            {
                roomJoin = true,
                room = roomName,
                canPublish = canPublish,
                canSubscribe = true,
            }
        });

        var encodedHeader = Base64UrlEncode(Encoding.UTF8.GetBytes(headerJson));
        var encodedPayload = Base64UrlEncode(Encoding.UTF8.GetBytes(payloadJson));
        var unsignedToken = $"{encodedHeader}.{encodedPayload}";

        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(apiSecret));
        var signature = hmac.ComputeHash(Encoding.UTF8.GetBytes(unsignedToken));
        var encodedSignature = Base64UrlEncode(signature);

        return $"{unsignedToken}.{encodedSignature}";
    }

    private static string Base64UrlEncode(byte[] bytes)
    {
        return Convert.ToBase64String(bytes)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }
}
