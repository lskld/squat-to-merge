using System.Collections.Concurrent;

namespace SquatToMerge.Server.Services;

public record RoomInfo
{
    public required string RoomId { get; init; }
    public required string RepoOwner { get; init; }
    public required string RepoName { get; init; }
    public required int PrNumber { get; init; }
    public required string PrAuthor { get; init; }
    public int SquatCount { get; set; }
    public bool IsMerged { get; set; }
}

public record WatchConfig
{
    public required string Owner { get; init; }
    public required string Repo { get; init; }
    public required long InstallationId { get; init; }
    public required int WebhookId { get; init; }
}

public class RoomManager
{
    private readonly ConcurrentDictionary<string, RoomInfo> _rooms = new();
    private readonly ConcurrentDictionary<string, WatchConfig> _watches = new();

    public RoomInfo CreateRoom(string repoOwner, string repoName, int prNumber, string prAuthor)
    {
        var roomId = $"{repoOwner}-{repoName}-pr-{prNumber}";
        var room = new RoomInfo
        {
            RoomId = roomId,
            RepoOwner = repoOwner,
            RepoName = repoName,
            PrNumber = prNumber,
            PrAuthor = prAuthor
        };
        _rooms[roomId] = room;
        return room;
    }

    public RoomInfo? GetRoom(string roomId) => _rooms.GetValueOrDefault(roomId);

    public IEnumerable<RoomInfo> GetAllRooms() => _rooms.Values;

    public void AddWatch(string owner, string repo, long installationId, int webhookId)
    {
        var key = $"{owner}/{repo}";
        _watches[key] = new WatchConfig
        {
            Owner = owner,
            Repo = repo,
            InstallationId = installationId,
            WebhookId = webhookId
        };
    }

    public WatchConfig? GetWatch(string owner, string repo) =>
        _watches.GetValueOrDefault($"{owner}/{repo}");

    public IEnumerable<WatchConfig> GetAllWatches() => _watches.Values;

    public bool RemoveWatch(string owner, string repo) =>
        _watches.TryRemove($"{owner}/{repo}", out _);
}
