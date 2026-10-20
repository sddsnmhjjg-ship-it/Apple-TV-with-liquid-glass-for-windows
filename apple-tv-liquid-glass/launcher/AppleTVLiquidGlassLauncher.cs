using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

[assembly: AssemblyTitle("Apple TV Liquid Glass")]
[assembly: AssemblyDescription("Native Apple TV (tv.apple.com) Windows Client with Real-Time Snell's Law Liquid Glass Refraction")]
[assembly: AssemblyProduct("Apple TV Liquid Glass")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

namespace AppleTVLiquidGlassApp
{
    internal static class Program
    {
        private static string ScriptSource;
        private static readonly HashSet<string> AttachedTargets = new HashSet<string>();

        [STAThread]
        private static void Main(string[] args)
        {
            ScriptSource = LoadLiquidGlassScript();

            string appDataRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "AppleTV_LiquidGlass"
            );
            string profileDir = Path.Combine(appDataRoot, "UserProfile");
            string extDir = Path.Combine(appDataRoot, "Extension");
            Directory.CreateDirectory(profileDir);
            Directory.CreateDirectory(extDir);

            SyncWidevineCdm(profileDir);
            WriteExtensionFiles(extDir);

            int debugPort = GetFreeLoopbackPort();
            string countryFile = Path.Combine(appDataRoot, "country.txt");
            string startUrl = "https://tv.apple.com";
            if (File.Exists(countryFile))
            {
                try
                {
                    string cc = File.ReadAllText(countryFile, new UTF8Encoding(false)).Trim().ToLowerInvariant();
                    if (!string.IsNullOrEmpty(cc) && cc.Length == 2 && Regex.IsMatch(cc, "^[a-z]{2}$"))
                    {
                        startUrl = "https://tv.apple.com/" + cc;
                    }
                }
                catch { }
            }

            Process browserProc = LaunchAppWindow(startUrl, profileDir, extDir, debugPort);
            if (browserProc == null) return;

            CancellationTokenSource cts = new CancellationTokenSource();
#pragma warning disable 4014
            Task.Run(() => MonitorAndInjectLoop(debugPort, cts.Token));
#pragma warning restore 4014

            try
            {
                // Keep injector alive as long as the browser profile has an active lock/window
                WaitForWindowClose(browserProc, profileDir, debugPort);
            }
            catch { }
            finally
            {
                cts.Cancel();
            }
        }

        private static void SyncWidevineCdm(string profileDir)
        {
            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                string progFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

                string[] candidateRoots = new string[]
                {
                    Path.Combine(localAppData, @"Google\Chrome\User Data\WidevineCdm"),
                    Path.Combine(localAppData, @"Microsoft\Edge\User Data\WidevineCdm"),
                    Path.Combine(progFiles, @"Google\Chrome\Application"),
                    Path.Combine(progFilesX86, @"Google\Chrome\Application"),
                    Path.Combine(progFiles, @"Microsoft\Edge\Application"),
                    Path.Combine(progFilesX86, @"Microsoft\Edge\Application")
                };

                Version bestVersion = new Version(0, 0, 0, 0);
                string bestDir = null;

                foreach (string root in candidateRoots)
                {
                    if (!Directory.Exists(root)) continue;

                    string[] manifests = Directory.GetFiles(root, "manifest.json", SearchOption.AllDirectories);
                    foreach (string manifestPath in manifests)
                    {
                        try
                        {
                            string dir = Path.GetDirectoryName(manifestPath);
                            if (!File.Exists(Path.Combine(dir, @"_platform_specific\win_x64\widevinecdm.dll")) &&
                                !File.Exists(Path.Combine(dir, "widevinecdm.dll")))
                            {
                                continue;
                            }

                            string text = File.ReadAllText(manifestPath);
                            Match m = Regex.Match(text, "\"version\"\\s*:\\s*\"([0-9\\.]+)\"");
                            if (m.Success)
                            {
                                Version v;
                                if (Version.TryParse(m.Groups[1].Value, out v))
                                {
                                    if (v > bestVersion)
                                    {
                                        bestVersion = v;
                                        bestDir = dir;
                                    }
                                }
                            }
                        }
                        catch { }
                    }
                }

                if (bestDir != null && bestVersion > new Version(0, 0, 0, 0))
                {
                    string destBase = Path.Combine(profileDir, "WidevineCdm");
                    string destVerDir = Path.Combine(destBase, bestVersion.ToString());
                    Directory.CreateDirectory(destVerDir);

                    string destDll = Path.Combine(destVerDir, @"_platform_specific\win_x64\widevinecdm.dll");
                    if (!File.Exists(destDll))
                    {
                        CopyDirectory(bestDir, destVerDir);
                    }
                }
            }
            catch { }
        }

        private static void CopyDirectory(string sourceDir, string destinationDir)
        {
            Directory.CreateDirectory(destinationDir);

            foreach (string file in Directory.GetFiles(sourceDir))
            {
                string destFile = Path.Combine(destinationDir, Path.GetFileName(file));
                try { File.Copy(file, destFile, true); } catch { }
            }

            foreach (string dir in Directory.GetDirectories(sourceDir))
            {
                string destSub = Path.Combine(destinationDir, Path.GetFileName(dir));
                CopyDirectory(dir, destSub);
            }
        }

        private static string LoadLiquidGlassScript()
        {
            string localFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "apple-tv-liquid-glass", "liquid-glass.js");
            if (File.Exists(localFile))
            {
                try { return File.ReadAllText(localFile, new UTF8Encoding(false)); } catch { }
            }

            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream("liquid-glass.js"))
            {
                if (s != null)
                {
                    using (StreamReader sr = new StreamReader(s, new UTF8Encoding(false)))
                    {
                        return sr.ReadToEnd();
                    }
                }
            }
            return "";
        }

        private static void WriteExtensionFiles(string extDir)
        {
            try
            {
                string manifest = "{\n" +
                    "  \"manifest_version\": 3,\n" +
                    "  \"name\": \"Apple TV Liquid Glass\",\n" +
                    "  \"version\": \"2.0.0\",\n" +
                    "  \"description\": \"Real-time Snell's law optical refraction for tv.apple.com.\",\n" +
                    "  \"content_scripts\": [\n" +
                    "    {\n" +
                    "      \"matches\": [\"https://tv.apple.com/*\"],\n" +
                    "      \"js\": [\"liquid-glass.js\"],\n" +
                    "      \"run_at\": \"document_start\"\n" +
                    "    }\n" +
                    "  ]\n" +
                    "}";
                File.WriteAllText(Path.Combine(extDir, "manifest.json"), manifest, new UTF8Encoding(false));
                File.WriteAllText(Path.Combine(extDir, "liquid-glass.js"), ScriptSource, new UTF8Encoding(false));
            }
            catch { }
        }

        private static int GetFreeLoopbackPort()
        {
            try
            {
                TcpListener preferred = new TcpListener(IPAddress.Loopback, 58856);
                preferred.Start();
                preferred.Stop();
                return 58856;
            }
            catch { }

            TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }

        private static Process LaunchAppWindow(string url, string profileDir, string extDir, int debugPort)
        {
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe")
            };

            string browserExe = null;
            foreach (string path in candidates)
            {
                if (File.Exists(path))
                {
                    browserExe = path;
                    break;
                }
            }

            if (browserExe == null)
            {
                return Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }

            string arguments = string.Format(
                "--app=\"{0}\" --user-data-dir=\"{1}\" --load-extension=\"{2}\" --remote-debugging-port={3} --remote-allow-origins=* --window-size=1480,920 --enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist --no-first-run --no-default-browser-check",
                url, profileDir, extDir, debugPort
            );

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = browserExe,
                Arguments = arguments,
                UseShellExecute = false
            };
            return Process.Start(psi);
        }

        private static void WaitForWindowClose(Process proc, string profileDir, int debugPort)
        {
            // Wait up to 8 seconds for the CDP endpoint to come online
            bool cdpEverConnected = false;
            for (int i = 0; i < 32; i++)
            {
                if (IsCdpAlive(debugPort))
                {
                    cdpEverConnected = true;
                    break;
                }
                Thread.Sleep(250);
            }

            if (cdpEverConnected)
            {
                while (IsCdpAlive(debugPort))
                {
                    Thread.Sleep(1000);
                }
            }
            else if (!proc.HasExited)
            {
                proc.WaitForExit();
            }
        }

        private static bool IsCdpAlive(int debugPort)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + debugPort + "/json/version");
                req.Timeout = 800;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static async Task MonitorAndInjectLoop(int debugPort, CancellationToken token)
        {
            string escapedScript = JsonEscape(ScriptSource);

            while (!token.IsCancellationRequested)
            {
                try
                {
                    string json = FetchString("http://127.0.0.1:" + debugPort + "/json");
                    if (!string.IsNullOrEmpty(json))
                    {
                        MatchCollection matches = Regex.Matches(
                            json,
                            "\"id\"\\s*:\\s*\"([^\"]+)\"[\\s\\S]*?\"type\"\\s*:\\s*\"page\"[\\s\\S]*?\"webSocketDebuggerUrl\"\\s*:\\s*\"([^\"]+)\""
                        );
                        foreach (Match m in matches)
                        {
                            string targetId = m.Groups[1].Value;
                            string wsUrl = m.Groups[2].Value;
                            lock (AttachedTargets)
                            {
                                if (AttachedTargets.Contains(targetId)) continue;
                                AttachedTargets.Add(targetId);
                            }
#pragma warning disable 4014
                            Task.Run(() => AttachAndInjectTarget(targetId, wsUrl, escapedScript, token));
#pragma warning restore 4014
                        }
                    }
                }
                catch { }

                await Task.Delay(900, token);
            }
        }

        private static async Task AttachAndInjectTarget(string targetId, string wsUrl, string escapedScript, CancellationToken token)
        {
            using (ClientWebSocket ws = new ClientWebSocket())
            {
                try
                {
                    await ws.ConnectAsync(new Uri(wsUrl), token);

                    await SendCdpCommand(ws, "{\"id\":1,\"method\":\"Page.enable\"}", token);
                    await SendCdpCommand(ws, "{\"id\":2,\"method\":\"Page.addScriptToEvaluateOnNewDocument\",\"params\":{\"source\":\"" + escapedScript + "\"}}", token);
                    await SendCdpCommand(ws, "{\"id\":3,\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":\"" + escapedScript + "\"}}", token);

                    byte[] buffer = new byte[16384];
                    int msgId = 10;
                    while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                    {
                        WebSocketReceiveResult result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                        if (result.MessageType == WebSocketMessageType.Close) break;

                        string msg = new UTF8Encoding(false).GetString(buffer, 0, result.Count);
                        if (msg.Contains("Page.frameNavigated") || msg.Contains("Page.loadEventFired") || msg.Contains("Page.domContentEventFired"))
                        {
                            Match mUrl = Regex.Match(msg, "\"url\"\\s*:\\s*\"https://tv\\.apple\\.com/([a-z]{2})(/|\"|\\?)", RegexOptions.IgnoreCase);
                            if (mUrl.Success)
                            {
                                try
                                {
                                    string cc = mUrl.Groups[1].Value.ToLowerInvariant();
                                    string cf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AppleTV_LiquidGlass", "country.txt");
                                    File.WriteAllText(cf, cc, new UTF8Encoding(false));
                                }
                                catch { }
                            }

                            msgId++;
                            await SendCdpCommand(ws, "{\"id\":" + msgId + ",\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":\"" + escapedScript + "\"}}", token);
                        }
                    }
                }
                catch { }
                finally
                {
                    lock (AttachedTargets)
                    {
                        AttachedTargets.Remove(targetId);
                    }
                }
            }
        }

        private static async Task SendCdpCommand(ClientWebSocket ws, string payload, CancellationToken token)
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(payload);
            await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token);
        }

        private static string FetchString(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 800;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (Stream s = resp.GetResponseStream())
                using (StreamReader sr = new StreamReader(s, new UTF8Encoding(false)))
                {
                    return sr.ReadToEnd();
                }
            }
            catch
            {
                return null;
            }
        }

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            StringBuilder sb = new StringBuilder(s.Length + 256);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '\"': sb.Append("\\\""); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32)
                            sb.AppendFormat("\\u{0:x4}", (int)c);
                        else
                            sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
