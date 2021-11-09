import utils from '../util/utils';
import stringify from 'json-stable-stringify-without-jsonify';

interface Link {
    source: {ieeeAddr: string, networkAddress: number}, target: {ieeeAddr: string, networkAddress: number},
    linkquality: number, depth: number, routes: zh.RoutingTableEntry[],
    sourceIeeeAddr: string, targetIeeeAddr: string, sourceNwkAddr: number, lqi: number, relationship: number,
}

interface Topology {
    nodes: {
        ieeeAddr: string, friendlyName: string, type: string, networkAddress: number, manufacturerName: string,
        modelID: string, failed: string[], lastSeen: number,
        definition: {model: string, vendor: string, supports: string, description: string}}[],
    links: Link[],
}

class DeviceNetworkMapExtension {
    constructor(zigbee, mqtt, state, publishEntityState, eventBus, settings, logger) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.state = state;
        this.publishEntityState = publishEntityState;
        this.eventBus = eventBus;
        this.settings = settings;
        this.logger = logger;

        logger.info('Loaded  PubishDevicesExtension');
        
        this.base_topic = settings.get().mqtt.base_topic;
    }

    /**
     * This method is called by the controller once Zigbee2MQTT has been started.
     */
    async start() {
        // All possible events can be seen here: https://github.com/Koenkk/zigbee2mqtt/blob/dev/lib/eventBus.ts

        // Subscribe to MQTT messages
        this.eventBus.onMQTTMessage(this, async (data) => {
            const topic = data.topic;
            if (topic == `${this.base_topic}/extension/report/device/networkmap`) {
                // instruct to get the device's network map
                const topology = await this.deviceNetworkScan(`0x00158d0001e5ce42`);
                let converted = stringify(topology);
                this.mqtt.publish(`${this.base_topic}/extension/response/device/networkmap`, converted as string, {});            
            }
        });
    }

    async deviceNetworkScan(ieeeAddr: string): Promise<Topology> {
        const devices = this.zigbee.devices().filter((d) => d.ieeeAddr === ieeeAddr);
        const lqis: Map<Device, zh.LQI> = new Map();
        const routingTables: Map<Device, zh.RoutingTable> = new Map();

        for (const device of devices.filter((d) => d.zh.type != 'EndDevice')) {

            const doRequest = async <T>(request: () => Promise<T>, firstAttempt = true): Promise<T> => {
                try {
                    return await request();
                } catch (error) {
                    if (!firstAttempt) {
                        throw error;
                    } else {
                        // Network is possibly congested, sleep 5 seconds to let the network settle.
                        await utils.sleep(5);
                        return doRequest(request, false);
                    }
                }
            };

            try {
                const result = await doRequest<zh.LQI>(async () => device.zh.lqi());
                lqis.set(device, result);
                this.logger.debug(`LQI succeeded for '${device.name}'`);

            } catch (error) {
                this.logger.error(`Failed to execute LQI for '${device.name}'`);
            }

            try {
                const result = await doRequest(async () => device.zh.routingTable());
                routingTables.set(device, result);
                this.logger.debug(`Routing table succeeded for '${device.name}'`);

            } catch (error) {
                this.logger.error(`Failed to execute routing table for '${device.name}'`);
            }
        }

        this.logger.info(`Network scan for ${ieeeAddr} finished`);

        const topology: Topology = {nodes: [], links: []};

        // Add links
        lqis.forEach((lqi, device) => {
            for (const neighbor of lqi.neighbors) {
                if (neighbor.relationship > 3) {
                    // Relationship is not active, skip it
                    continue;
                }

                // Some Xiaomi devices return 0x00 as the neighbor ieeeAddr (obviously not correct).
                // Determine the correct ieeeAddr based on the networkAddress.
                const neighborDevice = this.zigbee.deviceByNetworkAddress(neighbor.networkAddress);
                if (neighbor.ieeeAddr === '0x0000000000000000' && neighborDevice) {
                    neighbor.ieeeAddr = neighborDevice.ieeeAddr;
                }

                const link: Link = {
                    source: {ieeeAddr: neighbor.ieeeAddr, networkAddress: neighbor.networkAddress},
                    target: {ieeeAddr: device.ieeeAddr, networkAddress: device.zh.networkAddress},
                    linkquality: neighbor.linkquality, depth: neighbor.depth, routes: []
                };

                const routingTable = routingTables.get(device);

                if (routingTable) {
                    link.routes = routingTable.table
                        .filter((t) => t.status === 'ACTIVE' && t.nextHop === neighbor.networkAddress);
                }

                topology.links.push(link);
            }
        });

        return topology;
    }

    /**
     * Is called once the extension has to stop
     */
    async stop() {
        this.eventBus.removeListenersExtension(this);
    }
}

module.exports = DeviceNetworkMapExtension;