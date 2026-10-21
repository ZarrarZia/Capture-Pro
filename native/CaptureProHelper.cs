// CaptureProHelper — small native companion process for CapturePro.
// Protocol: one command per line on stdin ("<id> <cmd> [args...]"),
// one JSON object per line on stdout. Responses carry "id"; hook events carry "ev".
//
// Commands:
//   <id> foreground              -> foreground window info
//   <id> windows                 -> visible top-level windows, top of z-order first
//   <id> idle                    -> milliseconds since last user input
//   <id> hook on|off             -> start/stop global mouse+keyboard events
//   <id> ping
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Native
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }

    public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    public delegate bool MonitorEnumProc(IntPtr hmon, IntPtr hdc, ref RECT r, IntPtr data);

    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint dpiX, out uint dpiY);

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO lii);
    [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr hmod, uint thread);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern short GetKeyState(int vk);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetKeyNameText(int lParam, StringBuilder sb, int size);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string name);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int v, int size);
}

static class Program
{
    static readonly object OutLock = new object();
    static Thread hookThread;
    static uint hookThreadId;
    static Native.HookProc mouseProc, keyProc; // keep delegates alive
    static volatile bool mouseEvents;

    static void Main()
    {
        // Physical pixel coordinates everywhere (matches ffmpeg ddagrab/gfxcapture).
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        Console.InputEncoding = Encoding.UTF8;
        var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        Console.SetOut(stdout);
        Emit("{\"ev\":\"ready\"}");

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            var parts = line.Trim().Split(' ');
            if (parts.Length < 2) continue;
            string id = parts[0], cmd = parts[1];
            try
            {
                switch (cmd)
                {
                    case "ping": Reply(id, "\"ok\":true"); break;
                    case "foreground": Reply(id, WindowJson(Native.GetForegroundWindow())); break;
                    case "windows": Reply(id, "\"windows\":[" + string.Join(",", ListWindows()) + "]"); break;
                    case "monitors": Reply(id, "\"monitors\":[" + string.Join(",", ListMonitors()) + "]"); break;
                    case "idle":
                        var lii = new Native.LASTINPUTINFO { cbSize = 8 };
                        Native.GetLastInputInfo(ref lii);
                        Reply(id, "\"ms\":" + unchecked((uint)Environment.TickCount - lii.dwTime));
                        break;
                    case "hook":
                        if (parts.Length > 2 && parts[2] == "on") StartHooks(); else StopHooks();
                        Reply(id, "\"ok\":true");
                        break;
                    case "mouse": // mouse button events are only forwarded while enabled
                        mouseEvents = parts.Length > 2 && parts[2] == "on";
                        Reply(id, "\"ok\":true");
                        break;
                    default: Reply(id, "\"error\":\"unknown command\""); break;
                }
            }
            catch (Exception e) { Reply(id, "\"error\":" + Str(e.Message)); }
        }
        StopHooks();
    }

    static void Emit(string json) { lock (OutLock) Console.Out.WriteLine(json); }
    static void Reply(string id, string body) { Emit("{\"id\":" + Str(id) + (body.Length > 0 ? "," + body : "") + "}"); }

    static string Str(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static string WindowJson(IntPtr hwnd)
    {
        var title = new StringBuilder(512); Native.GetWindowText(hwnd, title, 512);
        var cls = new StringBuilder(256); Native.GetClassName(hwnd, cls, 256);
        Native.RECT r;
        // DWMWA_EXTENDED_FRAME_BOUNDS = 9 excludes the invisible resize border.
        if (Native.DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(Native.RECT))) != 0) Native.GetWindowRect(hwnd, out r);
        uint pid; Native.GetWindowThreadProcessId(hwnd, out pid);
        string exe = "";
        try { exe = Process.GetProcessById((int)pid).ProcessName; } catch { }

        var mi = new Native.MONITORINFO { cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO)) };
        Native.GetMonitorInfo(Native.MonitorFromWindow(hwnd, 2), ref mi);
        bool fullscreen = r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top &&
                          r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom &&
                          cls.ToString() != "Progman" && cls.ToString() != "WorkerW";

        return "\"hwnd\":" + hwnd.ToInt64() + ",\"title\":" + Str(title.ToString()) + ",\"class\":" + Str(cls.ToString()) +
               ",\"exe\":" + Str(exe) + ",\"pid\":" + pid +
               ",\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"w\":" + (r.Right - r.Left) + ",\"h\":" + (r.Bottom - r.Top) +
               ",\"fullscreen\":" + (fullscreen ? "true" : "false");
    }

    static List<string> ListWindows()
    {
        var list = new List<string>();
        Native.EnumWindows((hwnd, _) =>
        {
            if (!Native.IsWindowVisible(hwnd) || Native.IsIconic(hwnd)) return true;
            const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80;
            if ((Native.GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
            int cloaked; // DWMWA_CLOAKED = 14 (hidden UWP/virtual-desktop windows)
            if (Native.DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            var title = new StringBuilder(4);
            if (Native.GetWindowText(hwnd, title, 4) == 0) return true;
            list.Add("{" + WindowJson(hwnd) + "}");
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // Physical-pixel monitor rects in EnumDisplayMonitors order (the order ddagrab/gfxcapture use).
    static List<string> ListMonitors()
    {
        var list = new List<string>();
        Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hmon, IntPtr hdc, ref Native.RECT r, IntPtr data) =>
        {
            var mi = new Native.MONITORINFO { cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO)) };
            Native.GetMonitorInfo(hmon, ref mi);
            uint dx = 96, dy = 96;
            try { Native.GetDpiForMonitor(hmon, 0, out dx, out dy); } catch { }
            list.Add("{\"index\":" + list.Count + ",\"hmonitor\":" + hmon.ToInt64() +
                     ",\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"w\":" + (r.Right - r.Left) + ",\"h\":" + (r.Bottom - r.Top) +
                     ",\"primary\":" + ((mi.dwFlags & 1) != 0 ? "true" : "false") + ",\"scale\":" + (dx / 96.0).ToString(System.Globalization.CultureInfo.InvariantCulture) + "}");
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // ---- global input hooks -------------------------------------------------
    static void StartHooks()
    {
        if (hookThread != null) return;
        var ready = new ManualResetEvent(false);
        hookThread = new Thread(() =>
        {
            hookThreadId = Native.GetCurrentThreadId();
            IntPtr hmod = Native.GetModuleHandle(null);
            mouseProc = MouseHook; keyProc = KeyHook;
            IntPtr hm = Native.SetWindowsHookEx(14 /*WH_MOUSE_LL*/, mouseProc, hmod, 0);
            IntPtr hk = Native.SetWindowsHookEx(13 /*WH_KEYBOARD_LL*/, keyProc, hmod, 0);
            ready.Set();
            Native.MSG msg;
            while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            Native.UnhookWindowsHookEx(hm); Native.UnhookWindowsHookEx(hk);
        });
        hookThread.IsBackground = true;
        hookThread.Start();
        ready.WaitOne();
    }

    static void StopHooks()
    {
        if (hookThread == null) return;
        Native.PostThreadMessage(hookThreadId, 0x0012 /*WM_QUIT*/, IntPtr.Zero, IntPtr.Zero);
        hookThread.Join(1000);
        hookThread = null;
    }

    static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0 && mouseEvents)
        {
            int m = wParam.ToInt32();
            string type = null, btn = null;
            switch (m)
            {
                case 0x201: type = "down"; btn = "left"; break;
                case 0x202: type = "up"; btn = "left"; break;
                case 0x204: type = "down"; btn = "right"; break;
                case 0x205: type = "up"; btn = "right"; break;
                case 0x207: type = "down"; btn = "middle"; break;
                case 0x208: type = "up"; btn = "middle"; break;
                case 0x20A: type = "wheel"; btn = "wheel"; break;
            }
            if (type != null)
            {
                var s = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.MSLLHOOKSTRUCT));
                Emit("{\"ev\":\"mouse\",\"type\":\"" + type + "\",\"btn\":\"" + btn + "\",\"x\":" + s.pt.X + ",\"y\":" + s.pt.Y + "}");
            }
        }
        return Native.CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }

    static IntPtr KeyHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            int m = wParam.ToInt32();
            bool down = m == 0x100 || m == 0x104, up = m == 0x101 || m == 0x105;
            if (down || up)
            {
                var k = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                var mods = new List<string>();
                if ((Native.GetKeyState(0x11) & 0x8000) != 0) mods.Add("\"Ctrl\"");
                if ((Native.GetKeyState(0x12) & 0x8000) != 0 || m == 0x104 || m == 0x105) mods.Add("\"Alt\"");
                if ((Native.GetKeyState(0x10) & 0x8000) != 0) mods.Add("\"Shift\"");
                if ((Native.GetKeyState(0x5B) & 0x8000) != 0 || (Native.GetKeyState(0x5C) & 0x8000) != 0) mods.Add("\"Win\"");
                Emit("{\"ev\":\"key\",\"type\":\"" + (down ? "down" : "up") + "\",\"vk\":" + k.vkCode +
                     ",\"name\":" + Str(KeyName(k)) + ",\"mods\":[" + string.Join(",", mods) + "]}");
            }
        }
        return Native.CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }

    static string KeyName(Native.KBDLLHOOKSTRUCT k)
    {
        int vk = (int)k.vkCode;
        if (vk >= 0x70 && vk <= 0x87) return "F" + (vk - 0x6F);
        switch (vk)
        {
            case 0x08: return "Backspace"; case 0x09: return "Tab"; case 0x0D: return "Enter";
            case 0x1B: return "Esc"; case 0x20: return "Space"; case 0x2E: return "Delete";
            case 0x25: return "Left"; case 0x26: return "Up"; case 0x27: return "Right"; case 0x28: return "Down";
            case 0x10: case 0xA0: case 0xA1: return "Shift";
            case 0x11: case 0xA2: case 0xA3: return "Ctrl";
            case 0x12: case 0xA4: case 0xA5: return "Alt";
            case 0x5B: case 0x5C: return "Win";
        }
        int lp = (int)(k.scanCode << 16);
        if ((k.flags & 1) != 0) lp |= 1 << 24; // extended key
        var sb = new StringBuilder(64);
        return Native.GetKeyNameText(lp, sb, 64) > 0 ? sb.ToString() : ("VK" + vk);
    }
}
