using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.Tokens;

namespace SquatToMerge.Server.Services;

public class LiveKitService
{
    private readonly string _apiKey;
    private readonly string _apiSecret;
    private readonly string _url;

    public LiveKitService(IConfiguration config)
    {
        _apiKey = config["LiveKit:ApiKey"] ?? "";
        _apiSecret = config["LiveKit:ApiSecret"] ?? "";
        _url = config["LiveKit:Url"] ?? "";
    }

    public string GetUrl() => _url;

    public string GenerateToken(string roomName, string identity, bool canPublish)
    {
        if (string.IsNullOrEmpty(_apiKey) || string.IsNullOrEmpty(_apiSecret))
        {
            throw new InvalidOperationException(
                "LiveKit:ApiKey and LiveKit:ApiSecret must be configured. " +
                "Set them via Aspire user-secrets or environment variables.");
        }

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_apiSecret));
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var videoGrant = new Dictionary<string, object>
        {
            ["room"] = roomName,
            ["roomJoin"] = true,
            ["canPublish"] = canPublish,
            ["canSubscribe"] = true,
            ["canPublishData"] = true
        };

        var claims = new List<Claim>
        {
            new("sub", identity),
            new("video", JsonSerializer.Serialize(videoGrant), JsonClaimValueTypes.Json)
        };

        var token = new JwtSecurityToken(
            issuer: _apiKey,
            claims: claims,
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddHours(6),
            signingCredentials: credentials
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
