[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PayloadBase64)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class RustPocInput {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd,IntPtr insert,int x,int y,int w,int h,uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,System.Text.StringBuilder text,int max);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint flag);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd,uint command);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool InitializeTouchInjection(uint count,uint feedback);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool InjectTouchInput(uint count,ref TouchInfo pointer);
  [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr CreateSyntheticPointerDevice(uint type,uint count,uint feedback);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool InjectSyntheticPointerInput(IntPtr device,ref PointerTypeInfo pointer,uint count);
  [DllImport("user32.dll")] public static extern void DestroySyntheticPointerDevice(IntPtr device);
  [StructLayout(LayoutKind.Sequential)] public struct PointerInfo {
    public uint type,id,frame,flags; public IntPtr device,target; public Point pixel,himetric,pixelRaw,himetricRaw;
    public uint time,history; public int input; public uint keyStates; public ulong performance; public int button;
  }
  [StructLayout(LayoutKind.Sequential)] public struct TouchInfo {
    public PointerInfo pointer; public uint flags,mask; public Rect contact,contactRaw; public uint orientation,pressure;
  }
  [StructLayout(LayoutKind.Explicit,Size=152)] public struct PointerTypeInfo {[FieldOffset(0)]public uint type;[FieldOffset(8)]public TouchInfo touch;}
  public static int WantedProcess; public static Rect Allowed;
  public static void OwnPoint(int x,int y) {
    if(x<Allowed.Left||y<Allowed.Top||x>=Allowed.Right||y>=Allowed.Bottom)throw new Exception("Input point outside POC viewport");
    uint pid;GetWindowThreadProcessId(GetAncestor(WindowFromPoint(new Point{X=x,Y=y}),2),out pid);
    if(pid!=WantedProcess)throw new Exception("Another application covers the POC input point");
  }
  public static void OwnFocus(){uint pid;GetWindowThreadProcessId(GetAncestor(GetForegroundWindow(),2),out pid);if(pid!=WantedProcess)throw new Exception("POC lost keyboard focus; input stopped");}
  public static void Touch(int x,int y) {
    OwnFocus();OwnPoint(x,y);
    var device=CreateSyntheticPointerDevice(2,1,3);
    if(device==IntPtr.Zero)throw new Exception("CreateSyntheticPointerDevice error "+Marshal.GetLastWin32Error());
    var t=new TouchInfo();t.pointer.type=2;t.pointer.id=1;t.pointer.pixel=new Point{X=x,Y=y};
    t.pointer.flags=0x10000|2|4;t.mask=7;t.contact=new Rect{Left=x-3,Top=y-3,Right=x+3,Bottom=y+3};t.contactRaw=t.contact;t.pressure=512;t.orientation=90;
    var info=new PointerTypeInfo{type=2,touch=t};bool down=false;
    try{OwnFocus();OwnPoint(x,y);if(!InjectSyntheticPointerInput(device,ref info,1))throw new Exception("Synthetic DOWN error "+Marshal.GetLastWin32Error());down=true;Thread.Sleep(60);OwnFocus();OwnPoint(x,y);}
    finally{if(down){info.touch.pointer.flags=0x40000;if(!InjectSyntheticPointerInput(device,ref info,1)){DestroySyntheticPointerDevice(device);throw new Exception("Synthetic UP error "+Marshal.GetLastWin32Error());}}DestroySyntheticPointerDevice(device);}
  }
  public static void TypeAscii(string text) {
    foreach(char c in text){OwnFocus();byte vk=c==' '?(byte)32:(byte)Char.ToUpperInvariant(c);keybd_event(vk,0,0,UIntPtr.Zero);try{OwnFocus();}finally{keybd_event(vk,0,2,UIntPtr.Zero);}Thread.Sleep(110);}
  }
  public static void ToggleIme(){OwnFocus();keybd_event(17,0,0,UIntPtr.Zero);try{OwnFocus();keybd_event(32,0,0,UIntPtr.Zero);try{OwnFocus();}finally{keybd_event(32,0,2,UIntPtr.Zero);}}finally{keybd_event(17,0,2,UIntPtr.Zero);}Thread.Sleep(300);}
  public static List<object> Windows(int wanted) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var list=new List<object>();
    EnumWindows((hwnd,p)=>{uint pid;GetWindowThreadProcessId(hwnd,out pid);if(pid!=wanted)return true;
      var title=new System.Text.StringBuilder(1024);GetWindowText(hwnd,title,1024);Rect r;GetClientRect(hwnd,out r);var o=new Point();ClientToScreen(hwnd,ref o);
      Rect outer;GetWindowRect(hwnd,out outer);list.Add(new {hwnd=hwnd.ToInt64(),title=title.ToString(),visible=IsWindowVisible(hwnd),x=o.X,y=o.Y,width=r.Right-r.Left,height=r.Bottom-r.Top,outerX=outer.Left,outerY=outer.Top,outerWidth=outer.Right-outer.Left,outerHeight=outer.Bottom-outer.Top,dpi=GetDpiForWindow(hwnd),foreground=GetForegroundWindow()==hwnd,style=GetWindowLongPtr(hwnd,-16).ToInt64(),owner=GetWindow(hwnd,4).ToInt64()});return true;},IntPtr.Zero);
    return list;
  }
  public static void Click(int x,int y) {OwnPoint(x,y);SetCursorPos(x,y);Thread.Sleep(30);OwnPoint(x,y);mouse_event(2,0,0,0,UIntPtr.Zero);try{Thread.Sleep(40);OwnPoint(x,y);}finally{mouse_event(4,0,0,0,UIntPtr.Zero);}}
  public static void Drag(int x,int y,int endX,int endY) {OwnPoint(x,y);OwnPoint(endX,endY);SetCursorPos(x,y);mouse_event(2,0,0,0,UIntPtr.Zero);try{Thread.Sleep(100);for(int i=1;i<=20;i++){int px=x+(endX-x)*i/20,py=y+(endY-y)*i/20;OwnPoint(px,py);SetCursorPos(px,py);Thread.Sleep(25);}}finally{mouse_event(4,0,0,0,UIntPtr.Zero);}}
  public static void Wheel(int x,int y,int amount) {OwnPoint(x,y);SetCursorPos(x,y);Thread.Sleep(30);OwnPoint(x,y);mouse_event(0x800,0,0,unchecked((uint)amount),UIntPtr.Zero);}
}
'@
$taskPayload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
$taskWindows = @([RustPocInput]::Windows([int]$taskPayload.processId))
$taskGuest = $taskWindows | Where-Object { $_.title -like '*local guest fixture*' } | Select-Object -First 1
if (-not $taskGuest) { $taskGuest=$taskWindows | Where-Object { $_.title -eq 'WISP RS' -and $_.owner -eq 0 } | Select-Object -First 1 }
if (-not $taskGuest) { throw 'POC owner window is missing. Native input refused.' }
$taskWindow = [IntPtr]::new([long]$taskGuest.hwnd)
[RustPocInput]::WantedProcess=[int]$taskPayload.processId
$taskAllowed=[RustPocInput+Rect]::new();$taskAllowed.Left=$taskGuest.x;$taskAllowed.Top=$taskGuest.y;$taskAllowed.Right=$taskGuest.x+$taskGuest.width;$taskAllowed.Bottom=$taskGuest.y+$taskGuest.height
[RustPocInput]::Allowed=$taskAllowed
if ($taskPayload.action -in @('touch','type','toggle-ime')) {
  $taskForeground = [RustPocInput]::GetForegroundWindow().ToInt64()
  if (-not ($taskWindows | Where-Object { $_.hwnd -eq $taskForeground })) { throw 'POC does not own foreground input; keyboard/touch refused.' }
}
switch ($taskPayload.action) {
  'windows' { $taskWindows | ConvertTo-Json -Depth 4 -Compress; break }
  'click' {
    $taskX=[int]$taskPayload.x; $taskY=[int]$taskPayload.y
    if ($taskX -lt $taskGuest.x -or $taskY -lt $taskGuest.y -or $taskX -ge ($taskGuest.x+$taskGuest.width) -or $taskY -ge ($taskGuest.y+$taskGuest.height)) { throw 'Native click outside POC viewport refused.' }
    [RustPocInput]::Click($taskX,$taskY); break
  }
  'wheel' { [RustPocInput]::Wheel([int]$taskPayload.x,[int]$taskPayload.y,[int]$taskPayload.amount); break }
  'touch' { [RustPocInput]::Touch([int]$taskPayload.x,[int]$taskPayload.y); break }
  'type' { if ($taskPayload.text -notmatch '^[a-z ]{1,32}$') { throw 'Only the fixed short POC ASCII typing fixture is allowed.' };[RustPocInput]::TypeAscii([string]$taskPayload.text); break }
  'toggle-ime' { [RustPocInput]::ToggleIme(); break }
  'drag' { [RustPocInput]::Drag([int]$taskPayload.x,[int]$taskPayload.y,[int]$taskPayload.endX,[int]$taskPayload.endY); break }
  'focus' { [void][RustPocInput]::SetForegroundWindow($taskWindow); break }
  'minimize' { [void][RustPocInput]::ShowWindow($taskWindow,6); break }
  'restore' { [void][RustPocInput]::ShowWindow($taskWindow,9); break }
  'move' { [void][RustPocInput]::SetWindowPos($taskWindow,[IntPtr]::Zero,[int]$taskPayload.x,[int]$taskPayload.y,[int]$taskPayload.width,[int]$taskPayload.height,0x14); break }
  default { throw 'Unknown native POC action.' }
}
