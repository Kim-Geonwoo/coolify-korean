/**
 * 스크린샷 시험 인스턴스의 예시 리소스(php artisan tinker --execute). 빈 인스턴스는 서버·앱·DB·서비스 상세 화면이 열리지 않아
 * 그 키들에 스크린샷이 없다(2026-10-18 로컬 실측 362/4016키).
 * uuid는 고정값: 종류마다 화면 이름이 따로 생긴다(무작위 uuid면 모두 {id}가 되어 탐색이 한 개만 돈다).
 * 항목마다 따로 감싸, 하나가 실패해도 나머지는 만들고 SEED FAIL 줄로 알린다. 실제 자원은 없다(닿지 않는 서버 127.0.0.1, 예시 비밀번호)
 */
export const DEMO_SEED_PHP = String.raw`
$ok = 0; $bad = [];
$try = function (string $what, callable $fn) use (&$ok, &$bad) {
  try { $fn(); $ok++; } catch (\Throwable $e) { $bad[] = $what.': '.substr(preg_replace('/\s+/', ' ', $e->getMessage()), 0, 160); }
};
$key = null; $server = null; $env = null; $dest = null; $app = null; $pg = null;
$try('key', function () use (&$key) {
  $key = \App\Models\PrivateKey::where('team_id', 0)->where('name', 'coolify-ko demo')->first();
  if ($key === null) {
    $pair = \App\Models\PrivateKey::generateNewKeyPair('ed25519');
    $key = new \App\Models\PrivateKey;
    $key->forceFill(['team_id' => 0, 'name' => 'coolify-ko demo', 'description' => 'coolify-ko screenshots', 'private_key' => $pair['private_key']])->save();
  }
});
$try('server', function () use (&$server, &$key) {
  $server = \App\Models\Server::where('uuid', 'demo-server')->first();
  if ($server === null) {
    $server = new \App\Models\Server;
    $server->forceFill(['uuid' => 'demo-server', 'name' => 'demo-server', 'description' => 'coolify-ko screenshots', 'ip' => '127.0.0.1', 'port' => 22, 'user' => 'root', 'team_id' => 0, 'private_key_id' => $key->id, 'proxy' => ['type' => 'traefik', 'status' => 'exited']])->save();
  }
  foreach (\App\Models\Server::query()->get() as $each) {
    $each->settings?->forceFill(['is_reachable' => true, 'is_usable' => true])->save();
  }
});
$try('project', function () use (&$env, &$dest, &$server) {
  $project = \App\Models\Project::where('uuid', 'demo')->first();
  if ($project === null) {
    $project = new \App\Models\Project;
    $project->forceFill(['uuid' => 'demo', 'name' => 'Demo project', 'description' => 'coolify-ko screenshots', 'team_id' => 0])->save();
  }
  $env = $project->environments()->first();
  $dest = \App\Models\StandaloneDocker::where('server_id', $server->id)->first();
});
$git = ['git_repository' => 'coollabsio/coolify-examples', 'git_branch' => 'main'];
foreach ([
  ['demo-nixpacks', $git + ['build_pack' => 'nixpacks', 'base_directory' => '/nodejs', 'ports_exposes' => '3000']],
  ['demo-dockerfile', $git + ['build_pack' => 'dockerfile', 'base_directory' => '/dockerfile', 'ports_exposes' => '80']],
  ['demo-compose', $git + ['build_pack' => 'dockercompose', 'base_directory' => '/docker-compose', 'docker_compose_location' => '/docker-compose-test.yaml', 'ports_exposes' => '80']],
  ['demo-image', ['git_repository' => 'coollabsio/coolify', 'git_branch' => 'main', 'build_pack' => 'dockerimage', 'docker_registry_image_name' => 'nginx', 'docker_registry_image_tag' => 'alpine', 'ports_exposes' => '80']],
] as [$slug, $fields]) {
  $try($slug, function () use ($slug, $fields, &$env, &$dest, &$app) {
    $found = \App\Models\Application::where('uuid', $slug)->first();
    if ($found === null) {
      $found = new \App\Models\Application;
      $found->forceFill(array_merge(['uuid' => $slug, 'name' => $slug, 'fqdn' => "http://{$slug}.example.com", 'environment_id' => $env->id, 'destination_id' => $dest->id, 'destination_type' => \App\Models\StandaloneDocker::class, 'source_id' => 0, 'source_type' => \App\Models\GithubApp::class], $fields))->save();
    }
    $app ??= $found;
  });
}
foreach ([
  ['demo-postgres', \App\Models\StandalonePostgresql::class, fn () => create_standalone_postgresql($env->id, $dest, databaseImage: 'postgres:17-alpine')],
  ['demo-mysql', \App\Models\StandaloneMysql::class, fn () => create_standalone_mysql($env->id, $dest)],
  ['demo-mariadb', \App\Models\StandaloneMariadb::class, fn () => create_standalone_mariadb($env->id, $dest)],
  ['demo-mongodb', \App\Models\StandaloneMongodb::class, fn () => create_standalone_mongodb($env->id, $dest)],
  ['demo-redis', \App\Models\StandaloneRedis::class, fn () => create_standalone_redis($env->id, $dest)],
  ['demo-keydb', \App\Models\StandaloneKeydb::class, fn () => create_standalone_keydb($env->id, $dest)],
  ['demo-dragonfly', \App\Models\StandaloneDragonfly::class, fn () => create_standalone_dragonfly($env->id, $dest)],
  ['demo-clickhouse', \App\Models\StandaloneClickhouse::class, fn () => create_standalone_clickhouse($env->id, $dest)],
] as [$slug, $class, $make]) {
  $try($slug, function () use ($slug, $class, $make, &$pg) {
    $db = $class::where('uuid', $slug)->first();
    if ($db === null) {
      $db = $make();
      $db->forceFill(['uuid' => $slug, 'name' => $slug])->saveQuietly();
    }
    if ($slug === 'demo-postgres') {
      $pg = $db;
    }
  });
}
$try('demo-service', function () use (&$env, &$dest) {
  if (\App\Models\Service::where('uuid', 'demo-service')->exists()) {
    return;
  }
  $templates = get_service_templates();
  $name = $templates->has('umami') ? 'umami' : $templates->keys()->first();
  $service = new \App\Models\Service;
  $service->forceFill(['uuid' => 'demo-service', 'name' => 'demo-service', 'docker_compose_raw' => base64_decode((string) data_get($templates, "$name.compose")), 'environment_id' => $env->id, 'service_type' => $name, 'server_id' => $dest->server_id, 'destination_id' => $dest->id, 'destination_type' => $dest->getMorphClass()])->save();
  $service->parse(isNew: true);
  applyServiceApplicationPrerequisites($service);
});
$try('env-var', function () use (&$app) {
  \App\Models\EnvironmentVariable::firstOrCreate(['key' => 'DEMO_KEY', 'resourceable_type' => \App\Models\Application::class, 'resourceable_id' => $app->id, 'is_preview' => false], ['value' => 'demo']);
});
$try('storage', function () use (&$app) {
  \App\Models\LocalPersistentVolume::firstOrCreate(['name' => 'demo-data', 'resource_type' => \App\Models\Application::class, 'resource_id' => $app->id], ['mount_path' => '/data']);
});
$try('task', function () use (&$app) {
  if (! \App\Models\ScheduledTask::where('uuid', 'demo-task')->exists()) {
    (new \App\Models\ScheduledTask)->forceFill(['uuid' => 'demo-task', 'name' => 'demo-task', 'command' => 'echo hello', 'frequency' => '0 0 * * *', 'application_id' => $app->id, 'team_id' => 0, 'enabled' => true])->save();
  }
});
$try('backup', function () use (&$pg) {
  if (! \App\Models\ScheduledDatabaseBackup::where('uuid', 'demo-backup')->exists()) {
    (new \App\Models\ScheduledDatabaseBackup)->forceFill(['uuid' => 'demo-backup', 'team_id' => 0, 'frequency' => '0 0 * * *', 'database_id' => $pg->id, 'database_type' => \App\Models\StandalonePostgresql::class, 'enabled' => true, 'save_s3' => false])->save();
  }
});
$try('s3', function () {
  if (! \App\Models\S3Storage::where('uuid', 'demo-s3')->exists()) {
    (new \App\Models\S3Storage)->forceFill(['uuid' => 'demo-s3', 'name' => 'demo-s3', 'description' => 'coolify-ko screenshots', 'region' => 'us-east-1', 'key' => 'demo', 'secret' => 'demo', 'bucket' => 'demo', 'endpoint' => 'https://s3.example.com', 'team_id' => 0])->save();
  }
});
$try('github-app', function () {
  if (! \App\Models\GithubApp::where('uuid', 'demo-github')->exists()) {
    (new \App\Models\GithubApp)->forceFill(['uuid' => 'demo-github', 'name' => 'demo-github', 'api_url' => 'https://api.github.com', 'html_url' => 'https://github.com', 'custom_user' => 'git', 'custom_port' => 22, 'team_id' => 0, 'is_public' => false])->save();
  }
});
$try('invitation', function () {
  if (! \App\Models\TeamInvitation::where('uuid', 'demo-invite')->exists()) {
    (new \App\Models\TeamInvitation)->forceFill(['uuid' => 'demo-invite', 'team_id' => 0, 'email' => 'invitee@example.com', 'role' => 'member', 'link' => url('/invitations/demo-invite'), 'via' => 'link'])->save();
  }
});
$try('tag', function () use (&$app) {
  $tag = \App\Models\Tag::firstOrCreate(['name' => 'demo', 'team_id' => 0]);
  $app->tags()->syncWithoutDetaching([$tag->id]);
});
echo 'SEED ok='.$ok.' fail='.count($bad)."\n";
foreach ($bad as $line) { echo 'SEED FAIL '.$line."\n"; }
`;
