const axios = require('axios');

/**
 * Shelly Pro 1 PM Integration Service
 *
 * API Dokumentation: https://shelly-api-docs.shelly.cloud/gen2/
 */

class ShellyService {
  constructor() {
    this.devices = new Map();
  }

  /**
   * Registriere ein Shelly-Gerät
   */
  registerDevice(deviceId, ip, auth = null) {
    this.devices.set(deviceId, {
      ip,
      auth,
      baseUrl: `http://${ip}/rpc`
    });
  }

  /**
   * Hole Geräteinformationen
   */
  async getDeviceInfo(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not registered`);

    try {
      const response = await axios.get(`${device.baseUrl}/Shelly.GetDeviceInfo`, {
        timeout: 5000,
        auth: device.auth
      });
      return response.data;
    } catch (error) {
      console.error(`Error getting device info for ${deviceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Hole aktuellen Status des Switch (Ein/Aus)
   */
  async getSwitchStatus(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not registered`);

    try {
      const response = await axios.post(`${device.baseUrl}`, {
        id: 1,
        method: 'Switch.GetStatus',
        params: { id: 0 }
      }, {
        timeout: 5000,
        auth: device.auth
      });

      return response.data.result;
    } catch (error) {
      console.error(`Error getting switch status for ${deviceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Schalte Gerät ein
   */
  async turnOn(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not registered`);

    try {
      const response = await axios.post(`${device.baseUrl}`, {
        id: 1,
        method: 'Switch.Set',
        params: {
          id: 0,
          on: true
        }
      }, {
        timeout: 5000,
        auth: device.auth
      });

      return response.data.result;
    } catch (error) {
      console.error(`Error turning on ${deviceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Schalte Gerät aus
   */
  async turnOff(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not registered`);

    try {
      const response = await axios.post(`${device.baseUrl}`, {
        id: 1,
        method: 'Switch.Set',
        params: {
          id: 0,
          on: false
        }
      }, {
        timeout: 5000,
        auth: device.auth
      });

      return response.data.result;
    } catch (error) {
      console.error(`Error turning off ${deviceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Hole Energieverbrauchsdaten
   */
  async getEnergyData(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not registered`);

    try {
      const status = await this.getSwitchStatus(deviceId);

      return {
        // Aktuelle Leistung in Watt
        power: status.apower || 0,

        // Spannung in Volt
        voltage: status.voltage || 0,

        // Strom in Ampere
        current: status.current || 0,

        // Gesamtenergie in Wh (wird zu kWh konvertiert)
        totalEnergy: (status.aenergy?.total || 0) / 1000,

        // Energie für diese Session in Wh
        sessionEnergy: (status.aenergy?.by_minute?.[0] || 0) / 1000,

        // Temperatur des Geräts
        temperature: status.temperature?.tC || null,

        // Status
        isOn: status.output || false,

        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error(`Error getting energy data for ${deviceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Setze Timer für automatisches Ausschalten
   */
  async setTimer(deviceId, durationSeconds) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not registered`);

    try {
      const response = await axios.post(`${device.baseUrl}`, {
        id: 1,
        method: 'Switch.Set',
        params: {
          id: 0,
          auto_off: true,
          auto_off_delay: durationSeconds
        }
      }, {
        timeout: 5000,
        auth: device.auth
      });

      return response.data.result;
    } catch (error) {
      console.error(`Error setting timer for ${deviceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Reset Energiezähler
   */
  async resetEnergyCounter(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not registered`);

    try {
      const response = await axios.post(`${device.baseUrl}`, {
        id: 1,
        method: 'Switch.ResetCounters',
        params: {
          id: 0,
          type: ['aenergy']
        }
      }, {
        timeout: 5000,
        auth: device.auth
      });

      return response.data.result;
    } catch (error) {
      console.error(`Error resetting energy counter for ${deviceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Prüfe ob Gerät online ist
   */
  async isOnline(deviceId) {
    try {
      await this.getDeviceInfo(deviceId);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Hole Status aller registrierten Geräte
   */
  async getAllDevicesStatus() {
    const statuses = [];

    for (const [deviceId, device] of this.devices) {
      try {
        const status = await this.getSwitchStatus(deviceId);
        const energyData = await this.getEnergyData(deviceId);

        statuses.push({
          deviceId,
          ip: device.ip,
          online: true,
          ...energyData
        });
      } catch (error) {
        statuses.push({
          deviceId,
          ip: device.ip,
          online: false,
          error: error.message
        });
      }
    }

    return statuses;
  }
}

// Singleton Instance
const shellyService = new ShellyService();

module.exports = shellyService;
