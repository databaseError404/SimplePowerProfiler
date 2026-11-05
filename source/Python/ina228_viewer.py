"""Fast INA228 USB-COM viewer for the SimplePowerProfiler CH582 firmware.

The reader thread receives the existing length-prefixed protocol.  The GUI
thread only drains a queue and draws a decimated visible range, so high-rate
raw acquisition does not block serial reception.
"""

from __future__ import annotations

import csv
import json
import queue
import threading
import time
import tkinter as tk
from collections import deque
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

try:
    import serial
    from serial.tools import list_ports
except ImportError:  # pragma: no cover - shown in the GUI when launched
    serial = None
    list_ports = None


SPEEDS = [
    (20000, 50, 0),
    (11905, 84, 1),
    (6666, 150, 2),
    (3571, 280, 3),
    (1851, 540, 4),
    (950, 1052, 5),
    (482, 2074, 6),
    (242, 4120, 7),
]
INA_ADDR = 0x80
INA228_DID = 0x2281

CONFIG_PATH = Path(__file__).with_name("ina228_viewer.json")

# Calibration values use the same units as the Delphi dialog:
# voltage: V = ADC_code * U_coeff + U_offset
# current: mA = ADC_code * I_coeff + I_offset
# The default current coefficient is for the user's 0.1 Ohm shunt and the
# INA228 +/-163.84 mV range.  Values are intentionally editable in the GUI.
DEFAULT_CALIBRATION = {
    "shunt_range_mv": 163.84,
    "i_coeff": {"163.84": 0.00019613524, "40.96": 0.00004903381},
    "i_offset": {"163.84": 0.0, "40.96": 0.0},
    "u_coeff": 0.01220703125,
    "u_offset": 0.0,
}


def range_key(value: float) -> str:
    return "40.96" if abs(value - 40.96) < 0.01 else "163.84"


def load_calibration() -> dict:
    result = json.loads(json.dumps(DEFAULT_CALIBRATION))
    try:
        saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(saved, dict):
            for key in ("u_coeff", "u_offset", "shunt_range_mv"):
                if key in saved:
                    result[key] = float(saved[key])
            for key in ("i_coeff", "i_offset"):
                if isinstance(saved.get(key), dict):
                    for rkey in ("163.84", "40.96"):
                        if rkey in saved[key]:
                            result[key][rkey] = float(saved[key][rkey])
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    result["shunt_range_mv"] = 40.96 if abs(result["shunt_range_mv"] - 40.96) < 0.01 else 163.84
    return result


def save_calibration(calibration: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(calibration, indent=2), encoding="utf-8")


def make_frame(command: int, data: bytes = b"") -> bytes:
    return bytes((len(data), command)) + data


def signed24(value: int) -> int:
    return value - 0x1000000 if value & 0x800000 else value


class Device:
    """USB-COM protocol and packet reader."""

    def __init__(self) -> None:
        self.port = None
        self.thread = None
        self.stop_event = threading.Event()
        self.rx = bytearray()
        self.responses: queue.Queue[tuple[int, bytes]] = queue.Queue()
        self.samples: queue.Queue[tuple[int, int, int]] = queue.Queue()
        self.write_lock = threading.Lock()
        self.running = False
        self.speed_index = 1

    def open(self, port_name: str, speed_index: int, shunt_range_mv: float = 163.84) -> None:
        if serial is None:
            raise RuntimeError("Не установлен пакет pyserial")
        self.port = serial.Serial(port_name, 115200, timeout=0.1)
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._reader, daemon=True)
        self.thread.start()
        self.speed_index = speed_index
        try:
            self._command(0x00)
            mid = self._read_register(0xFE)
            did = self._read_register(0xFF) if mid == 0x5449 else 0
            if did != INA228_DID:
                raise RuntimeError(f"Обнаружен не INA228: 0x{did:04X}")
            self._command(0x18, bytes((2,)))
            self.start(speed_index, shunt_range_mv)
        except Exception:
            self.close()
            raise

    def start(self, speed_index: int, shunt_range_mv: float = 163.84) -> None:
        self.speed_index = speed_index
        self._command(0x01, self._config_data(speed_index, shunt_range_mv))
        self.running = True

    def stop(self) -> None:
        if self.port is not None:
            try:
                self._command(0x01, b"\x00", timeout=1.0)
            except Exception:
                pass
        self.running = False

    def close(self) -> None:
        if self.port is not None and self.running:
            self.stop()
        self.stop_event.set()
        if self.port is not None:
            try:
                self.port.close()
            except Exception:
                pass
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(timeout=0.5)
        self.thread = None
        self.port = None
        self.running = False

    def change_speed(self, speed_index: int, shunt_range_mv: float = 163.84) -> None:
        was_running = self.running
        if was_running:
            self.stop()
        self.clear_samples()
        self.speed_index = speed_index
        if was_running:
            self.start(speed_index, shunt_range_mv)

    def clear_samples(self) -> None:
        while True:
            try:
                self.samples.get_nowait()
            except queue.Empty:
                return

    def _command(self, command: int, data: bytes = b"", timeout: float = 2.0) -> bytes:
        if self.port is None:
            raise RuntimeError("Порт не открыт")
        with self.write_lock:
            self.port.write(make_frame(command, data))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                response_command, payload = self.responses.get(timeout=0.05)
            except queue.Empty:
                continue
            if (response_command & 0x7F) == command:
                if response_command & 0x80:
                    raise RuntimeError(f"Ошибка команды 0x{command:02X}")
                return payload
        raise TimeoutError(f"Нет ответа на команду 0x{command:02X}")

    def _read_register(self, register: int) -> int:
        payload = self._command(0x10, bytes((INA_ADDR, register)))
        if len(payload) < 4:
            raise RuntimeError("Короткий ответ чтения регистра")
        return payload[2] | (payload[3] << 8)

    @staticmethod
    def _config_data(speed_index: int, shunt_range_mv: float = 163.84) -> bytes:
        _, time_us, adc_index = SPEEDS[speed_index]
        adc_config = 0xB000 | (adc_index << 3) | (adc_index << 6) | (adc_index << 9)
        data = bytearray(38)
        data[0] = 20                 # packet contains 20 raw register reads
        data[1] = 0                  # timer multiplier
        data[2:4] = int(time_us).to_bytes(2, "little")
        data[4:6] = (1300).to_bytes(2, "little")

        shunt_config = 0x0010 if abs(shunt_range_mv - 40.96) < 0.01 else 0x0000
        init = [
            (INA_ADDR, 0x00, 0xC000),
            (INA_ADDR, 0x0B, 0x4000),
            (INA_ADDR, 0x00, shunt_config),
            (INA_ADDR, 0x01, adc_config),
        ]
        offset = 6
        for address, register, value in init:
            data[offset:offset + 4] = bytes((address, register)) + value.to_bytes(2, "little")
            offset += 4

        reads = [(INA_ADDR, 0x05), (INA_ADDR, 0x04), (0, 0), (0, 0)]
        for address, register in reads:
            data[offset:offset + 2] = bytes((address, register))
            offset += 2

        sleep = [(INA_ADDR, 0x01, 0x0000), (0, 0, 0x0000)]
        for address, register, value in sleep:
            data[offset:offset + 4] = bytes((address, register)) + value.to_bytes(2, "little")
            offset += 4
        return bytes(data)

    def _reader(self) -> None:
        while not self.stop_event.is_set():
            try:
                chunk = self.port.read(256) if self.port is not None else b""
            except Exception:
                break
            if chunk:
                self.rx.extend(chunk)
                self._parse()

    def _parse(self) -> None:
        while len(self.rx) >= 2:
            size = self.rx[0]
            total = size + 2
            if len(self.rx) < total:
                return
            command = self.rx[1]
            payload = bytes(self.rx[2:total])
            del self.rx[:total]
            if command == 0x3A:
                for offset in range(0, len(payload) - 6, 7):
                    voltage = payload[offset] | (payload[offset + 1] << 8) | (payload[offset + 2] << 16)
                    current = payload[offset + 3] | (payload[offset + 4] << 8) | (payload[offset + 5] << 16)
                    dio = payload[offset + 6]
                    self.samples.put((voltage, signed24(current), dio))
            else:
                self.responses.put((command, payload))


class ConfigDialog(tk.Toplevel):
    """Calibration dialog corresponding to the Delphi ADC Config window."""

    def __init__(self, parent: tk.Misc, calibration: dict, on_apply) -> None:
        super().__init__(parent)
        self.title("ADC Config")
        self.resizable(False, False)
        self.transient(parent)
        self.calibration = calibration
        self.on_apply = on_apply

        self.range_var = tk.DoubleVar(value=calibration["shunt_range_mv"])
        self.i_offset_var = tk.StringVar()
        self.i_coeff_var = tk.StringVar()
        self.u_offset_var = tk.StringVar(value=f'{calibration["u_offset"]:.11g}')
        self.u_coeff_var = tk.StringVar(value=f'{calibration["u_coeff"]:.11g}')

        body = ttk.Frame(self, padding=10)
        body.grid(row=0, column=0, sticky="nsew")

        range_box = ttk.LabelFrame(body, text="Shunt range")
        range_box.grid(row=0, column=0, rowspan=4, sticky="nsw", padx=(0, 14))
        ttk.Radiobutton(range_box, text="163.84 mV", variable=self.range_var,
                        value=163.84, command=self._load_range).pack(anchor=tk.W, padx=8, pady=4)
        ttk.Radiobutton(range_box, text="40.96 mV", variable=self.range_var,
                        value=40.96, command=self._load_range).pack(anchor=tk.W, padx=8, pady=4)

        ttk.Label(body, text="I offset (mA)").grid(row=0, column=1, sticky=tk.W, pady=3)
        ttk.Entry(body, textvariable=self.i_offset_var, width=18).grid(row=0, column=2, pady=3)
        ttk.Label(body, text="I coeff (mA/code)").grid(row=1, column=1, sticky=tk.W, pady=3)
        ttk.Entry(body, textvariable=self.i_coeff_var, width=18).grid(row=1, column=2, pady=3)
        ttk.Label(body, text="U offset (V)").grid(row=2, column=1, sticky=tk.W, pady=3)
        ttk.Entry(body, textvariable=self.u_offset_var, width=18).grid(row=2, column=2, pady=3)
        ttk.Label(body, text="U coeff (V/code)").grid(row=3, column=1, sticky=tk.W, pady=3)
        ttk.Entry(body, textvariable=self.u_coeff_var, width=18).grid(row=3, column=2, pady=3)

        ttk.Label(body, text="Коэффициенты применяются к raw-кодам АЦП.").grid(
            row=4, column=0, columnspan=3, sticky=tk.W, pady=(8, 3))
        buttons = ttk.Frame(body)
        buttons.grid(row=5, column=0, columnspan=3, sticky=tk.E, pady=(8, 0))
        ttk.Button(buttons, text="OK", command=self._apply).pack(side=tk.LEFT, padx=3)
        ttk.Button(buttons, text="Cancel", command=self.destroy).pack(side=tk.LEFT, padx=3)

        self._load_range()
        self.protocol("WM_DELETE_WINDOW", self.destroy)
        self.grab_set()
        self.focus_set()

    def _load_range(self) -> None:
        key = range_key(self.range_var.get())
        self.i_offset_var.set(f'{self.calibration["i_offset"][key]:.11g}')
        self.i_coeff_var.set(f'{self.calibration["i_coeff"][key]:.11g}')

    def _apply(self) -> None:
        try:
            key = range_key(self.range_var.get())
            i_offset = float(self.i_offset_var.get().replace(",", "."))
            i_coeff = float(self.i_coeff_var.get().replace(",", "."))
            u_offset = float(self.u_offset_var.get().replace(",", "."))
            u_coeff = float(self.u_coeff_var.get().replace(",", "."))
            if i_coeff <= 0 or u_coeff <= 0:
                raise ValueError("Коэффициенты должны быть больше нуля")
        except ValueError as exc:
            messagebox.showerror("ADC Config", f"Неверное значение: {exc}", parent=self)
            return

        updated = json.loads(json.dumps(self.calibration))
        updated["shunt_range_mv"] = 40.96 if key == "40.96" else 163.84
        updated["i_offset"][key] = i_offset
        updated["i_coeff"][key] = i_coeff
        updated["u_offset"] = u_offset
        updated["u_coeff"] = u_coeff
        self.on_apply(updated)
        self.destroy()


class Viewer:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("SimplePowerProfiler — INA228")
        self.root.geometry("1400x900")
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        self.device = Device()
        self.calibration = load_calibration()
        self.data: deque[tuple[float, float, float, float, float, int]] = deque(maxlen=1000)
        # Raw point layout is the same as averaged point layout, with DIO
        # appended, followed by the original ADC codes:
        # (time, min_u, avg_u, max_u, min_i, max_i, dio, adc_u, adc_i).
        self.raw: deque[tuple[float, float, float, float, float, float, int, int, int]] = deque()
        self.dio_changes: deque[tuple[float, int]] = deque()
        self.raw_count = 0
        self.dio_state = 0
        self.avg_start = None
        self.avg_values: list[tuple[float, float, float]] = []
        self.avg_period = 0.1
        self.raw_window = 30.0
        # Start in raw mode so the viewer shows every received sample by
        # default.  The averaged view remains available through the checkbox.
        self.raw_mode = tk.BooleanVar(value=True)
        self.adc_codes = tk.BooleanVar(value=False)
        self.follow_right = True
        self.user_window = False
        self.view_span = 1.0
        self.view_right = 1.0
        self.drag_x = None
        self.drag_view_right = None
        self.last_status = 0.0

        self.port_var = tk.StringVar()
        self.speed_var = tk.StringVar(value=self._speed_text(1))
        self.status_var = tk.StringVar(value="Порт закрыт")
        self.current_var = tk.StringVar(value="?")
        self.voltage_var = tk.StringVar(value="?")
        self.power_var = tk.StringVar(value="?")

        self._build_controls()
        self._build_graphs()
        self.refresh_ports()
        self.root.after(33, self.update)

    @staticmethod
    def _speed_text(index: int) -> str:
        sps, time_us, _ = SPEEDS[index]
        return f"{sps} SPS ({time_us} us)"

    def _build_controls(self) -> None:
        bar = ttk.Frame(self.root, padding=6)
        bar.pack(fill=tk.X)
        self.open_button = ttk.Button(bar, text="Open", command=self.toggle_port)
        self.open_button.pack(side=tk.LEFT)
        ttk.Label(bar, text=" COM:").pack(side=tk.LEFT)
        self.port_box = ttk.Combobox(bar, textvariable=self.port_var, width=18, state="readonly")
        self.port_box.pack(side=tk.LEFT, padx=3)
        ttk.Button(bar, text="Refresh", command=self.refresh_ports).pack(side=tk.LEFT)
        ttk.Label(bar, text="  INA228 speed:").pack(side=tk.LEFT)
        self.speed_box = ttk.Combobox(
            bar, textvariable=self.speed_var,
            values=[self._speed_text(i) for i in range(len(SPEEDS))],
            width=19, state="readonly")
        self.speed_box.pack(side=tk.LEFT, padx=3)
        self.speed_box.bind("<<ComboboxSelected>>", self.change_speed)
        ttk.Checkbutton(bar, text="Raw data (last 5 s)", variable=self.raw_mode,
                        command=self.reset_view).pack(side=tk.LEFT, padx=8)
        ttk.Checkbutton(bar, text="ADC codes", variable=self.adc_codes,
                        command=self.reset_view).pack(side=tk.LEFT, padx=3)
        ttk.Button(bar, text="ADC Config", command=self.open_config).pack(side=tk.LEFT, padx=5)
        ttk.Button(bar, text="Save CSV", command=self.save_csv).pack(side=tk.LEFT, padx=3)
        ttk.Label(bar, textvariable=self.status_var).pack(side=tk.LEFT, padx=8)

        values = ttk.Frame(self.root, padding=(10, 0, 10, 4))
        values.pack(fill=tk.X)
        for title, variable, color in (("Current", self.current_var, "#00ee77"),
                                       ("Voltage", self.voltage_var, "#ffff00"),
                                       ("Power", self.power_var, "#77bbff")):
            frame = ttk.Frame(values)
            frame.pack(side=tk.LEFT, expand=True)
            tk.Label(frame, text=title, fg=color, bg="#101015", font=("Arial", 12, "bold")).pack()
            tk.Label(frame, textvariable=variable, fg=color, bg="#101015", font=("Arial", 13, "bold")).pack()

    def _build_graphs(self) -> None:
        self.graph_frames = []
        self.canvases = []
        for height in (205, 245, 190):
            frame = tk.Frame(self.root, bg="#101015", height=height)
            frame.pack(fill=tk.X, expand=False)
            frame.pack_propagate(False)
            canvas = tk.Canvas(frame, bg="#101015", highlightthickness=0)
            canvas.pack(fill=tk.BOTH, expand=True)
            canvas.bind("<MouseWheel>", self.zoom)
            canvas.bind("<Button-1>", self.begin_drag)
            canvas.bind("<B1-Motion>", self.drag)
            canvas.bind("<ButtonRelease-1>", self.end_drag)
            canvas.bind("<Double-Button-1>", self.reset_view)
            self.graph_frames.append(frame)
            self.canvases.append(canvas)
        self.dio_status = tk.StringVar(value="DIO mask: 0x00")
        ttk.Label(self.root, textvariable=self.dio_status).pack(anchor=tk.W, padx=10)

    def refresh_ports(self) -> None:
        if list_ports is None:
            self.port_box["values"] = []
            self.status_var.set("Установите pyserial")
            return
        ports = [p.device for p in list_ports.comports()]
        self.port_box["values"] = ports
        if ports and self.port_var.get() not in ports:
            self.port_var.set(ports[0])

    def shunt_range_mv(self) -> float:
        return self.calibration["shunt_range_mv"]

    def current_coefficients(self) -> tuple[float, float]:
        key = range_key(self.shunt_range_mv())
        return self.calibration["i_coeff"][key], self.calibration["i_offset"][key]

    def open_config(self) -> None:
        ConfigDialog(self.root, self.calibration, self.apply_calibration)

    def apply_calibration(self, calibration: dict) -> None:
        old_range = self.shunt_range_mv()
        self.calibration = calibration
        self.reset_buffers()
        try:
            save_calibration(calibration)
        except OSError as exc:
            messagebox.showerror("ADC Config", f"Не удалось сохранить настройки:\n{exc}")
        if self.device.port is not None and abs(old_range - self.shunt_range_mv()) > 0.01:
            try:
                self.device.change_speed(self.speed_index(), self.shunt_range_mv())
                self.status_var.set("Диапазон шунта изменён")
            except Exception as exc:
                messagebox.showerror("ADC Config", str(exc))
        else:
            self.status_var.set("Коэффициенты применены")

    def toggle_port(self) -> None:
        if self.device.port is not None:
            self.device.close()
            self.open_button.configure(text="Open")
            self.status_var.set("Порт закрыт")
            return
        if not self.port_var.get():
            messagebox.showwarning("INA228", "Выберите COM-порт")
            return
        index = self.speed_index()
        self.open_button.configure(state=tk.DISABLED)
        self.status_var.set("Открытие...")
        self.root.update_idletasks()
        try:
            self.reset_buffers()
            self.device.open(self.port_var.get(), index, self.shunt_range_mv())
            self.open_button.configure(text="Close")
            self.status_var.set("INA228 запущен")
        except Exception as exc:
            messagebox.showerror("INA228", str(exc))
            self.status_var.set("Ошибка открытия")
        finally:
            self.open_button.configure(state=tk.NORMAL)

    def speed_index(self) -> int:
        try:
            return [self._speed_text(i) for i in range(len(SPEEDS))].index(self.speed_var.get())
        except ValueError:
            return 1

    def change_speed(self, _event=None) -> None:
        if self.device.port is None:
            self.status_var.set("Скорость применится при Open")
            return
        try:
            self.reset_buffers()
            self.device.change_speed(self.speed_index(), self.shunt_range_mv())
            self.status_var.set("Скорость изменена")
        except Exception as exc:
            messagebox.showerror("INA228", str(exc))

    def reset_buffers(self) -> None:
        self.device.clear_samples()
        self.data.clear()
        self.raw.clear()
        self.dio_changes.clear()
        self.raw_count = 0
        self.avg_start = None
        self.avg_values.clear()
        self.dio_state = 0
        self.user_window = False
        self.follow_right = True

    def reset_view(self, _event=None) -> None:
        self.user_window = False
        self.follow_right = True

    def raw_codes_active(self) -> bool:
        return self.raw_mode.get() and self.adc_codes.get()

    def drain_samples(self) -> None:
        processed = 0
        while processed < 10000:
            try:
                voltage_raw, current_raw, dio = self.device.samples.get_nowait()
            except queue.Empty:
                break
            t = self.raw_count / self.current_sps()
            voltage = voltage_raw * self.calibration["u_coeff"] + self.calibration["u_offset"]
            i_coeff, i_offset = self.current_coefficients()
            current_ma = current_raw * i_coeff + i_offset
            self.raw.append((t, voltage, voltage, voltage, current_ma, current_ma,
                             dio, voltage_raw, current_raw))
            limit = max(1000, int(self.current_sps() * self.raw_window))
            while len(self.raw) > limit:
                self.raw.popleft()
            while len(self.dio_changes) > 1 and self.dio_changes[0][0] < self.raw[0][0]:
                self.dio_changes.popleft()
            if processed == 0 and not self.dio_changes:
                self.dio_state = dio
                self.dio_changes.append((t, dio))
            elif dio != self.dio_state:
                self.dio_state = dio
                self.dio_changes.append((t, dio))
            # In raw mode do not spend time building the averaged series.  It
            # is still built when the user switches back to the averaged view.
            if not self.raw_mode.get():
                if self.avg_start is None:
                    self.avg_start = t
                    self.avg_values = [(voltage, current_ma)]
                elif t - self.avg_start < self.avg_period:
                    self.avg_values.append((voltage, current_ma))
                else:
                    self._commit_average(self.avg_start + self.avg_period, self.avg_values)
                    self.avg_start += self.avg_period
                    self.avg_values = [(voltage, current_ma)]
            self.raw_count += 1
            processed += 1
        if not self.raw_mode.get() and self.avg_values and self.avg_start is not None:
            self._commit_average(self.avg_start, self.avg_values, replace_last=True)

    def _commit_average(self, t: float, values: list[tuple[float, float]], replace_last=False) -> None:
        if not values:
            return
        us = [v[0] for v in values]
        currents = [v[1] for v in values]
        row = (t, min(us), sum(us) / len(us), max(us), min(currents), max(currents))
        if replace_last and self.data and abs(self.data[-1][0] - t) < self.avg_period * 1.5:
            self.data[-1] = row
        else:
            self.data.append(row)

    def current_sps(self) -> float:
        _, time_us, _ = SPEEDS[self.speed_index()]
        return 1000000.0 / (2.0 * time_us)

    def visible_data(self):
        if self.raw_mode.get():
            return list(self.raw)
        return list(self.data)

    def time_bounds(self):
        values = self.visible_data()
        if not values:
            return 0.0, 1.0
        return values[0][0], values[-1][0]

    def update_view(self) -> None:
        left, latest = self.time_bounds()
        if not self.user_window:
            self.view_right = latest
            self.view_span = max(1.0, latest - left)
        elif self.follow_right:
            self.view_right = latest
        self.view_right = max(self.view_right, left + 0.001)

    def update(self) -> None:
        self.drain_samples()
        self.update_view()
        self.draw_analog(0, "Voltage")
        self.draw_analog(1, "Current")
        self.draw_dio()
        self.update_status()
        self.root.after(33, self.update)

    def zoom(self, event) -> None:
        values = self.visible_data()
        if len(values) < 2:
            return
        left, latest = self.time_bounds()
        old_span = max(0.001, self.view_span)
        canvas = event.widget
        width = max(1, canvas.winfo_width())
        cursor_time = self.view_right - old_span * (1.0 - max(0.0, min(1.0, event.x / width)))
        factor = 0.8 if event.delta > 0 else 1.25
        new_span = max(0.002, min(max(0.002, latest - left), old_span * factor))
        fraction = (cursor_time - (self.view_right - old_span)) / old_span
        new_left = cursor_time - new_span * fraction
        self.view_span = new_span
        self.view_right = new_left + new_span
        self.user_window = True
        self.follow_right = self.view_right >= latest - max(0.01, new_span * 0.02)
        self.view_right = min(latest, self.view_right) if self.follow_right else self.view_right

    def begin_drag(self, event) -> None:
        self.drag_x = event.x
        self.drag_view_right = self.view_right

    def drag(self, event) -> None:
        if self.drag_x is None or self.drag_view_right is None:
            return
        width = max(1, event.widget.winfo_width())
        self.view_right = self.drag_view_right - (event.x - self.drag_x) * self.view_span / width
        self.user_window = True
        left, latest = self.time_bounds()
        self.follow_right = self.view_right + 0.01 >= latest
        self.view_right = min(latest, self.view_right) if self.follow_right else max(self.view_right, left + 0.001)

    def end_drag(self, _event) -> None:
        self.drag_x = None
        self.drag_view_right = None

    def plot_range(self, index: int):
        values = self.visible_data()
        if not values:
            return [], 0.0, 1.0
        left = self.view_right - self.view_span
        right = self.view_right
        visible = [row for row in values if left <= row[0] <= right]
        if len(visible) < 2:
            visible = values[-2:]
        if index == 0:
            if self.raw_codes_active():
                all_y = [row[7] for row in visible]
                return self.decimate(visible, index, raw_codes=True), min(all_y), max(all_y)
            all_y = [x for row in visible for x in row[1:4]]
            return self.decimate(visible, index), min(all_y), max(all_y)
        if self.raw_codes_active():
            all_y = [row[8] for row in visible]
            return self.decimate(visible, index, raw_codes=True), min(all_y), max(all_y)
        all_y = [x for row in visible for x in row[4:6]]
        return self.decimate(visible, index), min(all_y), max(all_y)

    @staticmethod
    def decimate(values, index: int, raw_codes: bool = False, max_points: int = 1800):
        if len(values) <= max_points:
            return values
        buckets = max(1, max_points // 2)
        step = len(values) / buckets
        result = []
        low_field = 7 if raw_codes and index == 0 else (8 if raw_codes else (1 if index == 0 else 4))
        high_field = low_field if raw_codes else (3 if index == 0 else 5)
        for bucket in range(buckets):
            a = int(bucket * step)
            b = min(len(values), max(a + 1, int((bucket + 1) * step)))
            lo = min(range(a, b), key=lambda i: values[i][low_field])
            hi = max(range(a, b), key=lambda i: values[i][high_field])
            ordered = sorted({lo, hi})
            result.extend(values[i] for i in ordered)
        return result

    def draw_analog(self, canvas_index: int, title: str) -> None:
        canvas = self.canvases[canvas_index]
        canvas.delete("all")
        width = max(10, canvas.winfo_width())
        height = max(10, canvas.winfo_height())
        points, low, high = self.plot_range(canvas_index)
        if not points:
            canvas.create_text(10, 10, anchor=tk.NW, fill="white", text=title)
            return
        if high <= low:
            high = low + 1.0
        pad_left, pad_right, pad_top, pad_bottom = 55, 8, 18, 20
        raw_codes = self.raw_codes_active()
        self.grid(canvas, width, height, pad_left, pad_right, pad_top, pad_bottom, low, high,
                  f"{title} (ADC code)" if raw_codes else title)
        left = self.view_right - self.view_span
        def xy(t, y):
            x = pad_left + (t - left) / self.view_span * (width - pad_left - pad_right)
            yy = height - pad_bottom - (y - low) / (high - low) * (height - pad_top - pad_bottom)
            return x, yy
        if raw_codes:
            field = 7 if canvas_index == 0 else 8
            center = [xy(row[0], row[field]) for row in points]
        else:
            center = [xy(row[0], row[2] if canvas_index == 0 else (row[4] + row[5]) / 2) for row in points]
        if self.raw_mode.get() or raw_codes:
            low_line = center
            high_line = center
        elif canvas_index == 0:
            low_line = [xy(row[0], row[1]) for row in points]
            high_line = [xy(row[0], row[3]) for row in points]
        else:
            low_line = [xy(row[0], row[4]) for row in points]
            high_line = [xy(row[0], row[5]) for row in points]
        fill = "#243b24" if canvas_index == 0 else "#145b3b"
        if len(low_line) > 1:
            polygon = low_line + list(reversed(high_line))
            canvas.create_polygon([p for xy_pair in polygon for p in xy_pair], fill=fill, outline="")
        color = "#ffff00" if canvas_index == 0 else "#00ee88"
        if len(center) > 1:
            canvas.create_line([p for xy_pair in center for p in xy_pair], fill=color, width=1)
        else:
            x, y = center[0]
            canvas.create_oval(x - 2, y - 2, x + 2, y + 2, fill=color, outline=color)

    @staticmethod
    def grid(canvas, width, height, left, right, top, bottom, low, high, title):
        canvas.create_text(width / 2, 8, text=title, fill="white", anchor=tk.N)
        for n in range(5):
            y = top + n * (height - top - bottom) / 4
            value = high - n * (high - low) / 4
            canvas.create_line(left, y, width - right, y, fill="#303038")
            canvas.create_text(left - 5, y, text=f"{value:.5g}", fill="#dddddd", anchor=tk.E)

    def draw_dio(self) -> None:
        canvas = self.canvases[2]
        canvas.delete("all")
        width = max(10, canvas.winfo_width())
        height = max(10, canvas.winfo_height())
        left, right, top, bottom = 55, 8, 12, 8
        self.grid(canvas, width, height, left, right, top, bottom, 0, 8, "Digital inputs")
        start = self.view_right - self.view_span
        changes = list(self.dio_changes)
        if not changes:
            return
        # Determine the state at the left edge from the complete history.
        # Without this, the first transition inside a zoomed window was used
        # as the baseline and the DIO trace could appear shifted or inverted.
        state = 0
        visible = []
        for t, mask in changes:
            if t <= start:
                state = mask
            elif t <= self.view_right:
                visible.append((t, mask))
        for bit in range(8):
            y0 = top + (7 - bit) * (height - top - bottom) / 8
            y1 = y0 + (height - top - bottom) / 8
            low_y = y0 + (y1 - y0) * 0.72
            high_y = y0 + (y1 - y0) * 0.22
            line = []
            t0 = start
            for t, mask in visible:
                if t < start:
                    state = mask
                    continue
                y = high_y if state & (1 << bit) else low_y
                line.extend((left + (t0 - start) / self.view_span * (width - left - right), y,
                             left + (t - start) / self.view_span * (width - left - right), y))
                line.extend((left + (t - start) / self.view_span * (width - left - right), y,
                             left + (t - start) / self.view_span * (width - left - right),
                             high_y if mask & (1 << bit) else low_y))
                state = mask
                t0 = t
            y = high_y if state & (1 << bit) else low_y
            line.extend((left + (t0 - start) / self.view_span * (width - left - right), y,
                         width - right, y))
            color = ("#00ffff", "#ffb000", "#00ff66", "#ff66cc",
                     "#66aaff", "#ffff66", "#cc99ff", "#ff9966")[bit]
            canvas.create_line(*line, fill=color, width=2)
            canvas.create_text(left - 5, (y0 + y1) / 2, text=f"DIO{bit}", fill="white", anchor=tk.E)

    def update_status(self) -> None:
        if not self.raw:
            return
        now = time.monotonic()
        if now - self.last_status < 0.2:
            return
        self.last_status = now
        _, _, u, _, i, _, dio, _, _ = self.raw[-1]
        self.current_var.set(f"{i:.6f} mA")
        self.voltage_var.set(f"{u:.6f} V")
        self.power_var.set(f"{u * i / 1000.0:.6f} W")
        self.dio_status.set("DIO mask: 0x%02X   " % dio + " ".join(f"DIO{b}={1 if dio & (1 << b) else 0}" for b in range(8)))

    def save_csv(self) -> None:
        if not self.raw:
            messagebox.showinfo("CSV", "Нет данных")
            return
        path = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=(("CSV", "*.csv"),))
        if not path:
            return
        with open(path, "w", newline="", encoding="utf-8") as file:
            writer = csv.writer(file, delimiter=";")
            writer.writerow(("time_s", "voltage_V", "current_mA", "dio_mask",
                             "voltage_adc", "current_adc"))
            for t, _, u, _, i, _, dio, voltage_raw, current_raw in self.raw:
                writer.writerow((f"{t:.9f}", f"{u:.9f}", f"{i:.9f}", f"0x{dio:02X}",
                                 voltage_raw, current_raw))
        self.status_var.set(f"CSV сохранён: {path}")

    def close(self) -> None:
        self.device.close()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    root.configure(bg="#101015")
    if serial is None:
        messagebox.showwarning("pyserial", "Не найден pyserial. Установите его командой: python -m pip install pyserial")
    Viewer(root)
    root.mainloop()


if __name__ == "__main__":
    main()
