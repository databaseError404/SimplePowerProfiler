/*
 * i2c_dev.c
 *
 *  Created on: 22.02.2020
 *      Author: pvvx
 */

#include "common.h"
#if (USE_I2C_DEV)
#include "app_drv_fifo.h"
#include "app_usb.h"
#include "i2c_dev.h"
#include "crc16.h"

#define MAX_I2C_PKTCNT16 60 // (SMPS_BLK_CNT/2)
#define MAX_I2C_PKTCNT24 40 // (SMPS_BLK_CNT/3)

#define MIN_TIM_IRQ 70000 // (min 55 us)  70000/clk_khz  2*5w*10bit*1500000/clk = us

i2c_dev_t i2c_dev; // I2C DEV flags & buffers
status_sps_t status;

typedef struct __attribute__((packed)) _i2c_blk_t{
	uint8_t count;
	uint8_t id;
	uint16_t data[MAX_I2C_PKTCNT16];
} i2c_blk_t;

i2c_blk_t i2c_blk;

/* Read DIO in the connector order defined in common.h. */
static inline uint8_t I2CDevReadDio(void) {
  uint32_t pa = GPIOA_ReadPort();
  return (uint8_t)(
      (((pa >> 4) & 0x01) << 0) |  // PA4  -> DIO0
      (((pa >> 5) & 0x01) << 1) |  // PA5  -> DIO1
      (((pa >> 15) & 0x01) << 2) | // PA15 -> DIO2
      (((pa >> 14) & 0x01) << 3) | // PA14 -> DIO3
      (((pa >> 13) & 0x01) << 4) | // PA13 -> DIO4
      (((pa >> 12) & 0x01) << 5) | // PA12 -> DIO5
      (((pa >> 11) & 0x01) << 6) | // PA11 -> DIO6
      (((pa >> 10) & 0x01) << 7));  // PA10 -> DIO7
}

#if USE_I2C_24BIT
const dev_i2c_cfg_t def_cfg_i2c  = {
    .pktcnt = 0, // max = SMPS_BLK_CNT;
    .multiplier = 0,
    .time = 1052, // us per INA228 channel conversion
    .clk_khz = 800,
    .init[0].dev_addr = I2C_ADDR_INA228,
    .init[0].reg_addr = INA228_RA_CONFIG,
    .init[0].data = 3<<14,  // System Reset sets registers to default values
    .init[1].dev_addr = I2C_ADDR_INA228,
    .init[1].reg_addr = INA228_RA_CONFIG,
    .init[1].data = 0x0000,  // Shunt full scale range 163.84 mV
    .init[2].dev_addr =I2C_ADDR_INA228,
    .init[2].reg_addr = INA228_RA_DIAG_ALRT,
    .init[2].data = 1<<14,  // Alert pin to be asserted when the Conversion Ready
    .init[3].dev_addr = I2C_ADDR_INA228,
    .init[3].reg_addr = INA228_RA_ADC_CONFIG,
    .init[3].data = 0x0000,
    .rd[0].dev_addr = I2C_ADDR_INA228,
    .rd[0].reg_addr = INA228_RA_VBUS,
    .rd[1].dev_addr = I2C_ADDR_INA228,
    .rd[1].reg_addr = INA228_RA_VSHUNT,
    .rd[2].dev_addr = 0x00,
    .rd[2].reg_addr = 0x00,
    .rd[3].dev_addr = 0x00,
    .rd[3].reg_addr = 0x00,
    .slp[0].dev_addr = I2C_ADDR_INA228,
    .slp[0].reg_addr = INA228_RA_ADC_CONFIG,
    .slp[0].data = 0x0000,
    .slp[1].dev_addr = 0x00,
    .slp[1].reg_addr = 0x00,
    .slp[1].data = 0x0000
};
#else
const dev_i2c_cfg_t def_cfg_i2c  = {
    .pktcnt = 0, // max = SMPS_BLK_CNT;
    .multiplier = 0, // * 16
    .time = 10000, // 10 ms
    .clk_khz = 1000, // 1 MHz
    .init[0].dev_addr = 0x80,
    .init[0].reg_addr = 0x0,
    .init[1].data = 0xc005,
    .init[1].dev_addr = 0x80,
    .init[1].reg_addr = 0x00,
    .init[1].data = 0xc005,
    .init[2].dev_addr = 0x80,
    .init[2].reg_addr = 0x00,
    .init[2].data = 0x4005,
    .init[3].dev_addr = 0x00,
    .init[3].reg_addr = 0x00,
    .init[3].data = 0x0000,
    .rd[0].dev_addr = 0x81,
    .rd[0].reg_addr = 0x01,
    .rd[1].dev_addr = 0x81,
    .rd[1].reg_addr = 0x02,
    .rd[2].dev_addr = 0x00,
    .rd[2].reg_addr = 0x00,
    .rd[3].dev_addr = 0x00,
    .rd[3].reg_addr = 0x00,
    .slp[0].dev_addr = 0x80,
    .slp[0].reg_addr = 0x00,
    .slp[0].data = 0x0000,
    .slp[1].dev_addr = 0x00,
    .slp[1].reg_addr = 0x00,
    .slp[1].data = 0x0000
};
#endif

// I2C DEV config (store EEP_ID_I2C_CFG)
dev_i2c_cfg_t cfg_i2c;
/*********************************************************************
 * @fn      TMR0_IRQHandler
 *
 * @brief   TMR0 IRQ
 *
 * @return  none
 */
__INTERRUPT
__HIGH_CODE
void TMR1_IRQHandler(void) {
#ifdef GPIO_TEST
  GPIOB_SetBits(GPIO_TEST);
#endif
  if(TMR1_GetITFlag(RB_TMR_IF_CYC_END)) {
	  if(i2c_dev.timer_flg) {
#if USE_I2C_24BIT
	    if(i2c_dev.i2c_rd_24bit) {
	      I2CBusRead24bits(i2c_dev.raddr->dev_addr, i2c_dev.raddr->reg_addr, &i2c_dev.i2c_buf[i2c_dev.i2c_buf_wr]);
	    }
	    else
#endif
	    {
	      I2CBusReadWord(i2c_dev.raddr->dev_addr, i2c_dev.raddr->reg_addr, &i2c_dev.i2c_buf[i2c_dev.i2c_buf_wr]);
	    }
	    i2c_dev.i2c_dio_buf[i2c_dev.i2c_buf_wr] = I2CDevReadDio();
	    i2c_dev.i2c_buf_wr++;
	    i2c_dev.raddr++;
	    if(i2c_dev.raddr->dev_addr == 0 || i2c_dev.raddr > &cfg_i2c.rd[MAX_READ_REGS-1]) {
	      i2c_dev.raddr = &cfg_i2c.rd[0];
	    }
	  }
    TMR1_ClearITFlag(RB_TMR_IF_CYC_END);
	}
#ifdef GPIO_TEST
	GPIOB_ResetBits(GPIO_TEST);
#endif
}

/* Flush I2C Buffer */
void I2CDevFlushBuf(void) {
  i2c_printf("Flush I2C Buffer\n");
  i2c_dev.raddr = &cfg_i2c.rd[0]; //	rd_next_cnt = 0;
  i2c_dev.i2c_buf_wr = 0;
  i2c_dev.i2c_buf_rd = 0;
}
/* Read Timer (IRQ) Stop */
void I2CDevTimerStop(void) {
  i2c_printf("I2C: Timer Stop\r\n");
  i2c_dev.timer_flg = 0;
  R8_TMR1_CTRL_MOD = 0;
}

void I2CDevTimerStart(void) {
  i2c_printf("I2C: Timer Start\r\n");
  R8_TMR1_CTRL_MOD = RB_TMR_ALL_CLEAR;
  R8_TMR1_CTRL_MOD = RB_TMR_COUNT_EN;
}

/* Timer Init (IRQ)*/
void I2CDevTimerInit(uint32_t period_us) {
  i2c_printf("I2C: Timer %i us\r\n", period_us);

  R32_TMR1_CNT_END = (FREQ_SYS/1000000)*period_us;
  R8_TMR1_CTRL_MOD = RB_TMR_ALL_CLEAR;
  R8_TMR1_CTRL_MOD = 0;
  //i2c_printf("I2C: Timer %i cnt\r\n", R32_TMR1_CNT_END);

  TMR1_ITCfg(ENABLE, TMR0_3_IT_CYC_END);
  PFIC_EnableIRQ(TMR1_IRQn);
}

/* I2C Device go Sleep */
void I2CDevSleep(void) {
	cfg_i2c.pktcnt = 0;
	I2CDevTimerStop();
	if(cfg_i2c.slp[0].dev_addr) {
	  i2c_printf("I2C: Set CLK %i kHz, stretch %u\n", cfg_i2c.clk_khz & 0x7fff, cfg_i2c.clk_khz >> 15);
		I2CBusInit();
		if(I2CBusWriteWord(cfg_i2c.slp[0].dev_addr,cfg_i2c.slp[0].reg_addr, cfg_i2c.slp[0].data)) // Power-Down (or Shutdown)
      PRINT("I2C: Error write addr: %02x:%02x, data: %04x!\r\n", cfg_i2c.slp[0].dev_addr, cfg_i2c.slp[0].reg_addr, cfg_i2c.slp[0].data);

		if(cfg_i2c.slp[1].dev_addr) {
		  if(I2CBusWriteWord(cfg_i2c.slp[1].dev_addr,cfg_i2c.slp[1].reg_addr, cfg_i2c.slp[1].data)) // Power-Down (or Shutdown)
		    PRINT("I2C: Error write addr: %02x:%02x, data: %04x!\r\n", cfg_i2c.slp[1].dev_addr, cfg_i2c.slp[1].reg_addr, cfg_i2c.slp[1].data);
		}
	}
	I2CBusDeInit();
#ifdef I2C_DEV_POWER
	i2c_printf("I2C: Power Off\r\n");
	GPIOB_ResetBits(I2C_DEV_POWER);
  GPIOB_ModeCfg(I2C_DEV_POWER | I2C_DEV_SCL | I2C_DEV_SDA, GPIO_ModeIN_Floating);
#endif
}

/* I2C Device WakeUp */
void I2CDevWakeUp(void) {
#ifdef I2C_DEV_POWER
	  GPIOB_ModeCfg(I2C_DEV_POWER | I2C_DEV_SCL | I2C_DEV_SDA, GPIO_ModeIN_PU);
	  sleep_us(128);
	  GPIOB_SetBits(I2C_DEV_POWER);
    GPIOB_ModeCfg(I2C_DEV_POWER, GPIO_ModeOut_PP_5mA);
    i2c_printf("I2C: Power On\r\n");
    GPIOB_ModeCfg(I2C_DEV_POWER, GPIO_ModeOut_PP_20mA);
    sleep_ms(2);
#endif
    cfg_i2c.pktcnt = 0;
    I2CDevStart();
}

int I2CDevReadSetings(void) {
  int ret = 1;
  if(FLASH_EEPROM_CMD(CMD_EEPROM_READ, 0, &cfg_i2c, sizeof(cfg_i2c))
   || crc16(0xffff, &cfg_i2c, sizeof(cfg_i2c))) {
    PRINT("I2C: Set default CFG\n");
    memcpy(&cfg_i2c, &def_cfg_i2c, sizeof(cfg_i2c)-2);
  } else
    ret = 0; // ok
  return ret;
}

int I2CDevWriteSetings(void) {
  dev_i2c_cfg_t tst_blk;
  int ret = 1;
  cfg_i2c.crc = crc16(0xffff, &cfg_i2c, sizeof(cfg_i2c)-2);
  if(FLASH_EEPROM_CMD(CMD_EEPROM_READ, 0, &tst_blk, sizeof(tst_blk)) == 0
   && memcmp(&tst_blk, &cfg_i2c, sizeof(cfg_i2c)) == 0) {
    ret = 0; // already - ok
  } else {
    if(FLASH_EEPROM_CMD(CMD_EEPROM_ERASE, 0, NULL, EEPROM_PAGE_SIZE)
     || FLASH_EEPROM_CMD(CMD_EEPROM_WRITE, 0, &cfg_i2c, sizeof(cfg_i2c))) {
      PRINT("I2C: Error write CFG\n");
    } else {
      i2c_printf("I2C: Write CFG - ok\r\n");
      ret = 0; // ok
    }
  }
  return ret;
}

/* I2C Device Init */
void I2CDevInit(void) {
    GPIOA_ModeCfg(DIO_INPUTS, DIO_INPUT_MODE);
    I2CDevReadSetings();
#ifdef I2C_DEV_POWER
    i2c_printf("I2C: Power Off\r\n");
    GPIOB_ResetBits(I2C_DEV_POWER);
    GPIOB_ModeCfg(I2C_DEV_POWER | I2C_DEV_SCL | I2C_DEV_SDA, GPIO_ModeIN_Floating);
#endif
}

/* I2C Device Start */
int I2CDevStart(void) {
	uint32_t i;
	uint32_t clk_khz;
	uint32_t t_rd_us;
	i2c_dev.timer_flg = 0;
#if USE_I2C_24BIT
	if(i2c_dev.i2c_rd_24bit) {
    if(cfg_i2c.pktcnt > MAX_I2C_PKTCNT24)
      cfg_i2c.pktcnt = MAX_I2C_PKTCNT24;
	} else
#endif
	{
	  if(cfg_i2c.pktcnt > MAX_I2C_PKTCNT16)
	    cfg_i2c.pktcnt = MAX_I2C_PKTCNT16;
	}
	clk_khz = cfg_i2c.clk_khz & 0x7fff;
	if(clk_khz < MIN_I2C_CLK_KHZ || clk_khz > MAX_I2C_CLK_KHZ) {
		clk_khz = DEF_I2C_CLK_KHZ;
		cfg_i2c.clk_khz &= 0x8000;
		cfg_i2c.clk_khz |= clk_khz;
	}
	i2c_printf("I2C: Set CLK %i kHz, stretch %u\n", cfg_i2c.clk_khz & 0x7fff, cfg_i2c.clk_khz >> 15);

	I2CBusInit();
	t_rd_us = cfg_i2c.time << cfg_i2c.multiplier;
	if(t_rd_us < MIN_TIM_IRQ/clk_khz) { // 2*5w*10bit*1000000/clk = us
		cfg_i2c.pktcnt = 0;
		I2CDevTimerStop();
		PRINT("I2C: Error timing - step read: %i us, i2c clk: %i kHz!\r\n", t_rd_us, clk_khz);
		return 0; // error t_us
	}
	I2CDevFlushBuf();
	if (cfg_i2c.pktcnt) {
	  I2CDevTimerInit(t_rd_us);
		// start (new) counts
	  status.all_read_count = 0;
		status.all_overflow_cnt = 0;
	} else {
	    I2CDevTimerStop();
		// выход по Stop (cfg_i2c.rd_count = 0), init dev i2c only
	}
	for(i = 0; i < MAX_INIT_REGS && cfg_i2c.init[i].dev_addr; i++) {
	  i2c_printf("I2C: Write %02x/%02x:%04x\r\n", cfg_i2c.init[i].dev_addr, cfg_i2c.init[i].reg_addr, cfg_i2c.init[i].data);
		if (I2CBusWriteWord(cfg_i2c.init[i].dev_addr, cfg_i2c.init[i].reg_addr, cfg_i2c.init[i].data)) {
			cfg_i2c.pktcnt = 0;
			I2CDevTimerStop();
			PRINT("I2C: Error write addr: %02x:%02x, data: %04x!\r\n", cfg_i2c.init[i].dev_addr, cfg_i2c.init[i].reg_addr, cfg_i2c.init[i].data);
			// return 0; // error dev i2c
		}
    sleep_us(512);
	}
	if (cfg_i2c.pktcnt) {
	  i2c_printf("I2C: blk %i word\r\n", cfg_i2c.pktcnt);
		if(i2c_dev.raddr->dev_addr) {
      sleep_us(t_rd_us);
      //i2c_printf("I2C: Sleep %u us\r\n", t_rd_us + 512);
#if USE_I2C_24BIT
      if(i2c_dev.i2c_rd_24bit > 1) {
        sleep_us(t_rd_us);
      }
#endif
		  i2c_dev.timer_flg = 1;
		  I2CDevTimerStart(); // Enable timer
		} else {
		  PRINT("I2C: Set read I2C addr!\r\n");
			return 0;
		}
	}
	return 1; // ok
}

#if USE_RAM_CODE
__HIGH_CODE
#endif
void I2CDevTask(void) {
	uint32_t prd = i2c_dev.i2c_buf_rd;
	uint32_t pwr = i2c_dev.i2c_buf_wr;
	uint32_t size;
	uint32_t raw_count;
	uint32_t idx;
	uint8_t *p = (uint8_t *)i2c_blk.data;
	if(!cfg_i2c.pktcnt)
		return;
	/* uint8_t ring indexes make subtraction wrap naturally at 256. */
	size = (uint8_t)(pwr - prd);
	if(size < cfg_i2c.pktcnt)
		return;

	raw_count = cfg_i2c.pktcnt;
	idx = prd;
#if USE_I2C_24BIT
	if(i2c_dev.i2c_rd_24bit) {
		/* INA228 data is VBUS/VSHUNT pairs plus one DIO byte per pair. */
		i2c_blk.count = (uint8_t)(raw_count * 3 + (raw_count / 2));
		i2c_blk.id = CMD_DEV_EADC;
		for(uint32_t n = 0; n < raw_count; n++) {
			uint32_t value = i2c_dev.i2c_buf[idx];
			*p++ = (uint8_t)value;
			*p++ = (uint8_t)(value >> 8);
			*p++ = (uint8_t)(value >> 16);
			/* The second reading in each VBUS/VSHUNT pair carries the snapshot. */
			if((n & 1) != 0)
				*p++ = i2c_dev.i2c_dio_buf[idx];
			idx = (idx + 1) & (I2C_BUF_SIZE - 1);
		}
	} else
#endif
	{
		i2c_blk.count = (uint8_t)(raw_count * 2);
		i2c_blk.id = CMD_DEV_I2C;
		for(uint32_t n = 0; n < raw_count; n++) {
			uint16_t value = (uint16_t)i2c_dev.i2c_buf[idx];
			*p++ = (uint8_t)value;
			*p++ = (uint8_t)(value >> 8);
			idx = (idx + 1) & (I2C_BUF_SIZE - 1);
		}
	}
	i2c_dev.i2c_buf_rd = (uint8_t)(prd + raw_count);
	size = 2 + i2c_blk.count;
  if(app_drv_fifo_write(&app_tx_fifo, (uint8_t *)&i2c_blk, (uint16_t *)&size) == APP_DRV_FIFO_RESULT_SUCCESS) {
    status.all_read_count++;
	} else {
#if !USE_RAM_CODE
	  PRINT("I2C: buffer overflow!\r\n");
#endif
	  status.all_overflow_cnt++;
	}
}

#endif // USE_I2C_DEV
