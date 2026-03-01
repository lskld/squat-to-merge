using Aspire.Hosting.DevTunnels;

var builder = DistributedApplication.CreateBuilder(args);

const int webfrontendPort = 5173;

// Secrets — set via: dotnet user-secrets set "Parameters:<name>" "<value>"
var githubAppId = builder.AddParameter("github-app-id", secret: true);
var githubAppSlug = builder.AddParameter("github-app-slug");
var githubClientId = builder.AddParameter("github-client-id", secret: true);
var githubClientSecret = builder.AddParameter("github-client-secret", secret: true);
var githubPrivateKeyPem = builder.AddParameter("github-private-key-pem", secret: true);
var webhookSecret = builder.AddParameter("webhook-secret", secret: true);
var livekitApiKey = builder.AddParameter("livekit-api-key", secret: true);
var livekitApiSecret = builder.AddParameter("livekit-api-secret", secret: true);
var livekitUrl = builder.AddParameter("livekit-url");
// Dev tunnel URL (secret)
var devTunnelUrl = builder.AddParameter("devtunnel-url", secret: true);
// Dev tunnel ID (read from user-secrets via configuration)
var devTunnelIdValue = builder.Configuration["Parameters:devtunnel-id"];

var server = builder.AddProject<Projects.squat_to_merge_Server>("server")
    .WithEndpoint("http", endpoint =>
    {
        endpoint.Port = 5000;
    })
    .WithEnvironment("GitHub__AppId", githubAppId)
    .WithEnvironment("GitHub__AppSlug", githubAppSlug)
    .WithEnvironment("GitHub__ClientId", githubClientId)
    .WithEnvironment("GitHub__ClientSecret", githubClientSecret)
    .WithEnvironment("GitHub__PrivateKeyPem", githubPrivateKeyPem)
    .WithEnvironment("GitHub__WebhookSecret", webhookSecret)
    .WithEnvironment("LiveKit__ApiKey", livekitApiKey)
    .WithEnvironment("LiveKit__ApiSecret", livekitApiSecret)
    .WithEnvironment("LiveKit__Url", livekitUrl)
    .WithEnvironment("DevTunnel__FrontendUrl", devTunnelUrl)
    .WithHttpHealthCheck("/health")
    .WithExternalHttpEndpoints();

var webfrontend = builder.AddViteApp("webfrontend", "../frontend")
    .WithEndpoint("http", endpoint =>
    {
        endpoint.Port = webfrontendPort;
    })
    .WithReference(server)
    .WaitFor(server);

// tunnels

builder.AddDevTunnel("tunnels", devTunnelIdValue,
    new DevTunnelOptions
    {
        AllowAnonymous = true
    })
    .WithReference(webfrontend.GetEndpoint("http")!)
    .WaitFor(webfrontend)
    .WithReference(server)
    .WaitFor(server);

server.PublishWithContainerFiles(webfrontend, "wwwroot");

builder.Build().Run();