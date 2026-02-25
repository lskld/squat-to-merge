using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Octokit;

namespace SquatToMerge.Server.Services;

public record GitHubRepositoryDto(
    long Id,
    string Name,
    string FullName,
    string Owner,
    bool IsPrivate,
    string? Description,
    long InstallationId);

public record GitHubUserDto(string Login, string AvatarUrl);

public class GitHubService(
    ILogger<GitHubService> logger,
    IConfiguration config,
    IHttpClientFactory httpClientFactory)
{
    private const string ApiVersion = "2022-11-28";

    private static GitHubClient CreateClient(string accessToken)
    {
        var client = new GitHubClient(new ProductHeaderValue("squat-to-merge"));
        client.Credentials = new Credentials(accessToken);
        return client;
    }

    public async Task<GitHubUserDto> GetAuthenticatedUserAsync(string userAccessToken)
    {
        var http = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.github.com/user");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", userAccessToken);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.Add("X-GitHub-Api-Version", ApiVersion);
        request.Headers.UserAgent.ParseAdd("squat-to-merge/1.0");

        using var response = await http.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        var login = json.GetProperty("login").GetString() ?? throw new InvalidOperationException("GitHub login missing.");
        var avatar = json.TryGetProperty("avatar_url", out var av) ? av.GetString() ?? string.Empty : string.Empty;

        return new GitHubUserDto(login, avatar);
    }

    public async Task<IReadOnlyList<GitHubRepositoryDto>> GetRepositoriesForUserAsync(string userAccessToken)
    {
        var installationIds = await GetUserInstallationIdsAsync(userAccessToken);
        if (installationIds.Count == 0)
        {
            return [];
        }

        var reposByKey = new Dictionary<string, GitHubRepositoryDto>(StringComparer.OrdinalIgnoreCase);

        foreach (var installationId in installationIds)
        {
            var installationToken = await CreateInstallationTokenAsync(installationId);
            var repos = await GetInstallationRepositoriesAsync(installationToken, installationId);

            foreach (var repo in repos)
            {
                var key = repo.FullName;
                if (!reposByKey.ContainsKey(key))
                {
                    reposByKey[key] = repo;
                }
            }
        }

        return reposByKey.Values
            .OrderBy(r => r.FullName, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public async Task<long> GetInstallationIdForRepoAsync(string owner, string repo)
    {
        var appJwt = CreateAppJwt();

        var http = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get,
            $"https://api.github.com/repos/{owner}/{repo}/installation");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", appJwt);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.Add("X-GitHub-Api-Version", ApiVersion);
        request.Headers.UserAgent.ParseAdd("squat-to-merge/1.0");

        using var response = await http.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("id").GetInt64();
    }

    public async Task<int> CreateWebhookAsync(
        long installationId,
        string owner,
        string repo,
        string webhookUrl,
        string secret)
    {
        var client = await CreateInstallationClientAsync(installationId);

        var config = new Dictionary<string, string>
        {
            { "url", webhookUrl },
            { "content_type", "json" },
            { "secret", secret }
        };

        var hook = new NewRepositoryWebHook("web", config, webhookUrl)
        {
            Events = ["pull_request"],
            Active = true
        };

        var created = await client.Repository.Hooks.Create(owner, repo, hook);
        logger.LogInformation("Created webhook {WebhookId} for {Owner}/{Repo} via installation {InstallationId}",
            created.Id, owner, repo, installationId);
        return created.Id;
    }

    public async Task DeleteWebhookAsync(long installationId, string owner, string repo, int webhookId)
    {
        var client = await CreateInstallationClientAsync(installationId);
        await client.Repository.Hooks.Delete(owner, repo, webhookId);
        logger.LogInformation("Deleted webhook {WebhookId} for {Owner}/{Repo} via installation {InstallationId}",
            webhookId, owner, repo, installationId);
    }

    public async Task PostPrCommentAsync(
        long installationId,
        string owner,
        string repo,
        int prNumber,
        string body)
    {
        var client = await CreateInstallationClientAsync(installationId);
        await client.Issue.Comment.Create(owner, repo, prNumber, body);
        logger.LogInformation("Posted comment on PR #{PrNumber} in {Owner}/{Repo}", prNumber, owner, repo);
    }

    public async Task MergePrAsync(long installationId, string owner, string repo, int prNumber)
    {
        var client = await CreateInstallationClientAsync(installationId);
        await client.PullRequest.Merge(owner, repo, prNumber, new MergePullRequest
        {
            CommitTitle = $"Merged via Squat-to-Merge! 💪🏋️ (PR #{prNumber})",
            MergeMethod = PullRequestMergeMethod.Merge
        });
        logger.LogInformation("Merged PR #{PrNumber} in {Owner}/{Repo}", prNumber, owner, repo);
    }

    private async Task<GitHubClient> CreateInstallationClientAsync(long installationId)
    {
        var token = await CreateInstallationTokenAsync(installationId);
        return CreateClient(token);
    }

    private async Task<List<long>> GetUserInstallationIdsAsync(string userAccessToken)
    {
        var http = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.github.com/user/installations");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", userAccessToken);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.Add("X-GitHub-Api-Version", ApiVersion);
        request.Headers.UserAgent.ParseAdd("squat-to-merge/1.0");

        using var response = await http.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        var installations = json.GetProperty("installations").EnumerateArray();

        var ids = new List<long>();
        foreach (var installation in installations)
        {
            ids.Add(installation.GetProperty("id").GetInt64());
        }

        return ids;
    }

    private async Task<List<GitHubRepositoryDto>> GetInstallationRepositoriesAsync(
        string installationToken,
        long installationId)
    {
        var http = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.github.com/installation/repositories");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", installationToken);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.Add("X-GitHub-Api-Version", ApiVersion);
        request.Headers.UserAgent.ParseAdd("squat-to-merge/1.0");

        using var response = await http.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        var repos = json.GetProperty("repositories").EnumerateArray();

        var result = new List<GitHubRepositoryDto>();
        foreach (var repo in repos)
        {
            var owner = repo.GetProperty("owner").GetProperty("login").GetString() ?? string.Empty;
            var fullName = repo.GetProperty("full_name").GetString() ?? string.Empty;
            var name = repo.GetProperty("name").GetString() ?? string.Empty;
            var isPrivate = repo.GetProperty("private").GetBoolean();
            var description = repo.TryGetProperty("description", out var desc)
                ? desc.GetString()
                : null;

            result.Add(new GitHubRepositoryDto(
                Id: repo.GetProperty("id").GetInt64(),
                Name: name,
                FullName: fullName,
                Owner: owner,
                IsPrivate: isPrivate,
                Description: description,
                InstallationId: installationId));
        }

        return result;
    }

    private async Task<string> CreateInstallationTokenAsync(long installationId)
    {
        var appJwt = CreateAppJwt();

        var http = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"https://api.github.com/app/installations/{installationId}/access_tokens");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", appJwt);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.Add("X-GitHub-Api-Version", ApiVersion);
        request.Headers.UserAgent.ParseAdd("squat-to-merge/1.0");

        using var response = await http.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        return json.GetProperty("token").GetString()
            ?? throw new InvalidOperationException("Installation token missing from GitHub response.");
    }

    private string CreateAppJwt()
    {
        var appId = config["GitHub:AppId"]
            ?? throw new InvalidOperationException("GitHub:AppId is not configured.");
        var privateKeyPem = config["GitHub:PrivateKeyPem"]
            ?? throw new InvalidOperationException("GitHub:PrivateKeyPem is not configured.");

        var now = DateTimeOffset.UtcNow;
        var iat = now.AddSeconds(-60).ToUnixTimeSeconds();
        var exp = now.AddMinutes(9).ToUnixTimeSeconds();

        var header = Base64UrlEncode("{\"alg\":\"RS256\",\"typ\":\"JWT\"}");
        var payload = Base64UrlEncode($"{{\"iat\":{iat},\"exp\":{exp},\"iss\":\"{appId}\"}}");
        var unsignedToken = $"{header}.{payload}";

        using var rsa = RSA.Create();
        rsa.ImportFromPem(privateKeyPem);

        var signatureBytes = rsa.SignData(
            Encoding.UTF8.GetBytes(unsignedToken),
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);

        return $"{unsignedToken}.{Base64UrlEncode(signatureBytes)}";
    }

    private static string Base64UrlEncode(string value) => Base64UrlEncode(Encoding.UTF8.GetBytes(value));

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
}
